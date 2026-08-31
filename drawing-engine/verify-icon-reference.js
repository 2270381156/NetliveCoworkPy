/* node 自测：技能里的图标参考页必须与 catalog.json 保持一致，且两份技能副本逐字节相同。
   用法： node verify-icon-reference.js

   为什么需要：参考页是给 agent 挑图标看的（skill_executor__read_file 读），catalog.json 是
   引擎解析图标用的。两者内容重叠、来源不同——正是本项目反复出事的形态（style-report 自己
   臆断哪些 glyph 画得出来，给出假的全清；normalizeEncoding 只有一个引擎调用，另一个漏掉）。
   这里用生成器的 --check 把"参考页 = catalog 的投影"这条钉死：catalog 改了不重新生成就红。 */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fail++; };

const ROOT = path.join(__dirname, "..");
const SKILL_A = path.join(ROOT, "resources", "skills", "topology-drawing");

console.log("① 参考页与 catalog.json 一致（catalog 改了必须重新生成）");
{
  const r = spawnSync(process.execPath, [path.join(__dirname, "gen-icon-reference.js"), "--check"],
    { encoding: "utf8" });
  ok(r.status === 0, `gen-icon-reference.js --check 通过${r.status === 0 ? "" : "：" + (r.stderr || r.stdout).trim()}`);
}

console.log("② 参考页覆盖 catalog 里的每一个 key（漏一个就等于 agent 永远选不到它）");
{
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "topology-icons", "catalog.json"), "utf8"));
  const icons = catalog.icons || catalog;
  const ref = fs.readFileSync(path.join(SKILL_A, "references", "icon-catalog.md"), "utf8");
  const missing = Object.keys(icons).filter(k => !ref.includes("`" + k + "`"));
  ok(missing.length === 0, `全部 ${Object.keys(icons).length} 个 key 都在参考页里（缺失 ${JSON.stringify(missing)}）`);
}

console.log("③ 主 SKILL.md 真的指向了参考页（否则 agent 不知道有这份清单）");
{
  const skill = fs.readFileSync(path.join(SKILL_A, "SKILL.md"), "utf8");
  ok(skill.includes("references/icon-catalog.md"), "SKILL.md 里出现 references/icon-catalog.md");
  ok(/skill_executor__read_file/.test(skill), "并且说清了用哪个工具读它");
}

/* ④ skill 只有一份。

   这条检查改过两次，两次都是因为**改了别处忘了改它**：

   一、原先校验的是"resources/ 与 packaging/default_data/ 两份副本逐字节一致"。
       2026-07-30 副本删掉了，脚本没同步，它拿着不存在的路径 readdirSync 直接抛异常。
   二、改成"打包脚本的 skill 源指向这里"之后，打包脚本又不再打 skill 包了（那一节整个
       移除），这条再次失效。

   而 npm run verify 是 && 链，它一挂后面四个脚本（svg-geometry/vsdx/pptx/serve）全不跑。

   所以这次只留**本目录能自己验证的事**：skill 在不在该在的地方。打包脚本怎么处理 skill
   是打包脚本的事，不该由引擎的校验脚本来断言——那正是前两次失效的根源。 */
console.log("④ skill 单一来源");
{
  ok(fs.existsSync(path.join(SKILL_A, "SKILL.md")), `skill 在 resources/skills/topology-drawing/`);
}

console.log("⑤ frontmatter 只用引擎认识的键（name/description/triggers/version）");
{
  const skill = fs.readFileSync(path.join(SKILL_A, "SKILL.md"), "utf8");
  // 行尾必须容忍 CRLF：本脚本读的是**工作区**文件，而 Windows 上的编辑器/脚本很容易把它
  // 写成 CRLF（git 只在入库时归一成 LF）。只认 \n 会误报"没有 frontmatter"——实际踩过一次。
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
  ok(!!m, "存在 frontmatter");
  if (m) {
    const KNOWN = new Set(["name", "description", "triggers", "version"]);
    const keys = m[1].split(/\r?\n/).filter(l => /^\w/.test(l)).map(l => l.split(":")[0]);
    const unknown = keys.filter(k => !KNOWN.has(k));
    // 写了引擎不解析的键（比如照搬 SOUL.md 的 tools:）不会报错，只会被静默忽略——
    // 那正好是"以为自己声明了、其实没有"的沉默失败。
    ok(unknown.length === 0, `无引擎不认识的键（多余的 ${JSON.stringify(unknown)}）`);
    ok(keys.includes("name") && keys.includes("description"), "name / description 齐全（缺了不会被扫描到）");
  }
}

console.log(fail ? `\n✗ ${fail} 项失败` : "\n✓ 全部通过");
process.exit(fail ? 1 : 0);
