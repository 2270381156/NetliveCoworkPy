'use strict';
const fs = require('fs');
const path = require('path');

const PER_FILE_MAX = 2 * 1024 * 1024;   // 单文件 2MB 上限
const TREE_BUDGET = 16 * 1024 * 1024;   // skills+agents 合计 raw 预算 16MB

const errMsg = (e) => String((e && e.message) || e);

// Recursively collect files under `dir` into zip entries named `${prefix}/<relpath>`
// (posix separators), deterministic (relpath-sorted). Enforces a per-file size cap
// and a shared byte budget; over-cap → skipped(file-too-large), first over-budget
// file and all later ones → skipped(budget-exceeded). stat/read failures → errors.
// Absent dir → { present:false, ...empty }. Never throws.
function collectDirTree({ dir, prefix, perFileBytes = PER_FILE_MAX, budgetRemaining = TREE_BUDGET, fsImpl = fs }) {
  const out = { entries: [], skipped: [], errors: [], bytesUsed: 0, present: false };
  try { if (!fsImpl.statSync(dir).isDirectory()) return out; } catch (_) { return out; }
  out.present = true;

  const rels = [];
  (function walk(cur, relBase) {
    let dirents;
    try { dirents = fsImpl.readdirSync(cur, { withFileTypes: true }); }
    catch (e) { out.errors.push({ path: relBase ? `${prefix}/${relBase}` : prefix, reason: errMsg(e) }); return; }
    for (const de of dirents) {
      const rel = relBase ? `${relBase}/${de.name}` : de.name;
      if (de.isDirectory()) walk(path.join(cur, de.name), rel);
      else if (de.isFile()) rels.push(rel);
    }
  })(dir, '');
  rels.sort();

  let remaining = budgetRemaining;
  let budgetHit = false;
  for (const rel of rels) {
    const full = path.join(dir, rel);
    const name = `${prefix}/${rel}`;
    let size;
    try { size = fsImpl.statSync(full).size; } catch (e) { out.errors.push({ path: name, reason: errMsg(e) }); continue; }
    if (size > perFileBytes) { out.skipped.push({ path: name, bytes: size, reason: 'file-too-large' }); continue; }
    if (budgetHit || size > remaining) { budgetHit = true; out.skipped.push({ path: name, bytes: size, reason: 'budget-exceeded' }); continue; }
    let data;
    try { data = fsImpl.readFileSync(full); } catch (e) { out.errors.push({ path: name, reason: errMsg(e) }); continue; }
    out.entries.push({ name, data });
    out.bytesUsed += data.length;
    remaining -= data.length;
  }
  return out;
}

// Read an explicit allowlist of files into zip entries. No size cap (config-sized).
// Missing file (ENOENT) → absent; other read failure → errors. Never throws.
function collectFiles({ files, fsImpl = fs }) {
  const out = { entries: [], included: [], absent: [], errors: [] };
  for (const f of files) {
    let data;
    try { data = fsImpl.readFileSync(f.path); }
    catch (e) {
      if (e && e.code === 'ENOENT') out.absent.push(f.name);
      else out.errors.push({ path: f.name, reason: errMsg(e) });
      continue;
    }
    out.entries.push({ name: f.name, data });
    out.included.push(f.name);
  }
  return out;
}

// Assemble the manifest object (spec §6) from per-source collection results.
function buildReportManifest({ sessionId, skillsDir, agentsDir, skills, agents, cfgFiles, llm, mcp }) {
  return {
    generated_for_session: sessionId || '',
    sources: {
      skills: { status: skills.present ? 'present' : 'absent', dir: skillsDir, included: skills.entries.length, bytes: skills.bytesUsed },
      agents: { status: agents.present ? 'present' : 'absent', dir: agentsDir, included: agents.entries.length, bytes: agents.bytesUsed },
      config: {
        included: [...cfgFiles.included, ...llm.entries.map((e) => e.name), ...mcp.entries.map((e) => e.name)],
        absent: cfgFiles.absent,
      },
    },
    skipped: [...skills.skipped, ...agents.skipped, ...llm.skipped, ...mcp.skipped],
    errors: [...skills.errors, ...agents.errors, ...cfgFiles.errors, ...llm.errors, ...mcp.errors],
  };
}

// Gather all extra report data (skills/agents trees + config allowlist) into zip
// entries + a manifest. skills & agents share the 16MB TREE_BUDGET; llm/mcp config
// subdirs use their own budget (config isn't starved by big skills). Never throws.
function gatherExtraReportData({ sessionId, skillsDir, agentsDir, dataDir, resourcesDir, envPath, fsImpl = fs }) {
  const skills = collectDirTree({ dir: skillsDir, prefix: 'skills', fsImpl });
  const agents = collectDirTree({ dir: agentsDir, prefix: 'agents', budgetRemaining: TREE_BUDGET - skills.bytesUsed, fsImpl });
  const cfgFiles = collectFiles({ fsImpl, files: [
    { path: envPath, name: 'config/.env' },
    { path: path.join(dataDir, 'skill_references.json'), name: 'config/skill_references.json' },
    { path: path.join(dataDir, 'skill_pull_config.json'), name: 'config/skill_pull_config.json' },
    { path: path.join(resourcesDir, 'mcp.json'), name: 'config/mcp.json' },
  ] });
  const llm = collectDirTree({ dir: path.join(dataDir, 'llm_configs'), prefix: 'config/llm_configs', fsImpl });
  const mcp = collectDirTree({ dir: path.join(dataDir, 'mcp_configs'), prefix: 'config/mcp_configs', fsImpl });

  const entries = [...skills.entries, ...agents.entries, ...cfgFiles.entries, ...llm.entries, ...mcp.entries];
  const manifest = buildReportManifest({ sessionId, skillsDir, agentsDir, skills, agents, cfgFiles, llm, mcp });
  return { entries, manifest };
}

module.exports = { PER_FILE_MAX, TREE_BUDGET, collectDirTree, collectFiles, buildReportManifest, gatherExtraReportData };
