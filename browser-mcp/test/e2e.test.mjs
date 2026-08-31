/**
 * End-to-end tests against the built server + a real Chrome.
 *
 * Run: npm run build && npm test
 *
 * These cover the bugs fixed in 0.2.0:
 *   - every declared tool actually dispatches (get_snapshot used to return
 *     "Unknown tool"),
 *   - click/fill by ref hit the element the snapshot showed (the ref numbering
 *     used to disagree between snapshot and click),
 *   - a stale ref reports an actionable error instead of silently missing,
 *   - navigate returns promptly for an instantly-loaded page (the load event
 *     used to be subscribed after Page.navigate, so it could be missed),
 *   - tabs keyed by tab_id stay isolated.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");

// browser_status 已从工具面移除（agent 用不到，白占 prompt 预算）。测试仍需要观测
// 浏览器状态，改为直连 CDP 的 HTTP 端点——这是 Chrome 自带的，不需要 MCP 暴露工具。
const CDP_PORT = 9222;
async function cdpTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    if (!res.ok) return null;
    return (await res.json()).filter((t) => t.type === "page");
  } catch {
    return null;   // Chrome 没起
  }
}

let child;
let nextId = 1;
const pending = new Map();

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC ${method} timed out after 90s`));
    }, 90_000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
  });
}

async function callTool(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  const text = (res.result?.content ?? []).map((c) => c.text).join("");
  let json = null;
  try { json = JSON.parse(text); } catch { /* plain text result */ }
  return { text, json, isError: res.result?.isError === true };
}

before(async () => {
  child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], cwd: ROOT });
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = msg.id !== undefined && pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg); }
      } catch { /* not a complete JSON line */ }
    }
  });
  child.stderr.on("data", (d) => {
    if (process.env.VERBOSE) process.stderr.write(d);
  });

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0" },
  });
  assert.equal(init.result?.serverInfo?.name, "browser-mcp");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});

after(async () => {
  try {
    await callTool("browser_shutdown", { tab_id: "t1" });
    await callTool("browser_shutdown", { tab_id: "t2" });
  } catch { /* ignore */ }
  // Close stdin rather than killing outright, so the server's shutdown hooks
  // run and the Chrome it launched (plus its tabs and launch lock) is cleaned up.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
  child.kill();
});

/** Replace the document body with fixed markup, and reset the click recorder. */
async function seedPage(tabId) {
  const html = `
    <div><div><div><span>filler one</span></div></div></div>
    <div><span>filler two</span></div>
    <button id="b1">Alpha</button>
    <button id="b2">Bravo</button>
    <input id="i1" placeholder="Query box">
  `;
  const r = await callTool("evaluate", {
    tab_id: tabId,
    expression: `(() => {
      document.body.innerHTML = ${JSON.stringify(html)};
      window.__clicked = null;
      for (const b of document.querySelectorAll('button')) {
        b.addEventListener('click', () => { window.__clicked = b.id; });
      }
      return document.querySelectorAll('button').length;
    })()`,
  });
  assert.equal(r.json?.value, 2, "seed page created two buttons");
}

/** Pull [ref] for the first snapshot line whose name matches. */
function refFor(snapshotText, name) {
  const line = snapshotText.split("\n").find((l) => l.includes(`"${name}"`));
  assert.ok(line, `snapshot has a node named "${name}":\n${snapshotText}`);
  return Number(line.match(/\[(\d+)\]/)[1]);
}

test("every declared tool has a working handler", async () => {
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "browser_launch", "browser_shutdown",
    "click", "click_and_read", "evaluate", "fill",
    "get_snapshot", "navigate",
    "open_and_search", "wait_for_selector", "wait_for_sso",
  ]);
  // The dispatch table is asserted against this list at startup; a missing
  // handler would have aborted the server before it answered initialize.
  for (const t of list.result.tools) {
    assert.ok(t.description?.length > 20, `${t.name} has a description`);
    assert.equal(t.inputSchema?.type, "object", `${t.name} has an object schema`);
  }
});

test("browser_shutdown on an unknown tab does not launch a browser", async () => {
  const before = (await cdpTargets()) !== null;
  const r = await callTool("browser_shutdown", { tab_id: "never-used" });
  assert.equal(r.json?.closed, false);
  assert.match(r.json?.reason ?? "", /no open session/);
  if (!before) {
    assert.equal(await cdpTargets(), null, "shutdown did not launch Chrome");
  }
});

test("browser_launch creates a dedicated tab", async () => {
  const r = await callTool("browser_launch", { tab_id: "t1" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json?.tab_id, "t1");
  assert.ok(r.json?.target_id, "a target_id was returned");
});

test("browser_launch start_url navigates the caller's own tab", async () => {
  const r = await callTool("browser_launch", { tab_id: "t4", start_url: "about:blank#start" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json?.url ?? "", /#start$/);
  const where = await callTool("evaluate", { tab_id: "t4", expression: "location.href" });
  assert.match(where.json?.value ?? "", /#start$/, "the session's tab is the one that navigated");
  await callTool("browser_shutdown", { tab_id: "t4" });
});

test("navigate to about:blank returns promptly (load event not missed)", async () => {
  const started = Date.now();
  const r = await callTool("navigate", { tab_id: "t1", url: "about:blank", wait_ms: 30000 });
  const elapsed = Date.now() - started;
  assert.equal(r.json?.navigated, true);
  // Pre-fix, the load event fired before the listener was attached and this
  // burned the full 30s timeout.
  assert.ok(elapsed < 10_000, `navigate took ${elapsed}ms; expected well under the 30s timeout`);
});

test("same-document (#hash) navigation does not wait for a load event", async () => {
  await callTool("navigate", { tab_id: "t1", url: "about:blank" });
  const started = Date.now();
  // A fragment navigation fires no load event at all; waiting for one used to
  // consume the whole wait_ms budget.
  const r = await callTool("navigate", { tab_id: "t1", url: "about:blank#section", wait_ms: 20000 });
  const elapsed = Date.now() - started;
  assert.equal(r.json?.navigated, true);
  assert.match(r.json?.url ?? "", /#section$/);
  assert.ok(elapsed < 5000, `hash navigation took ${elapsed}ms; expected to return without waiting`);
});

test("get_snapshot returns a structured tree with refs", async () => {
  await seedPage("t1");
  const snap = await callTool("get_snapshot", { tab_id: "t1" });
  assert.equal(snap.isError, false, snap.text);
  assert.match(snap.text, /^PAGE: /, "snapshot starts with the PAGE header");
  assert.match(snap.text, /URL: about:blank/);
  assert.match(snap.text, /button "Alpha"/);
  assert.match(snap.text, /button "Bravo"/);
  assert.match(snap.text, /textbox "Query box"/);
  // Wrapper divs with no text of their own must not be emitted.
  assert.doesNotMatch(snap.text, /\bdiv ""/);
});

test("click by ref hits exactly the element the snapshot showed", async () => {
  await seedPage("t1");
  const snap = await callTool("get_snapshot", { tab_id: "t1" });
  const bravoRef = refFor(snap.text, "Bravo");

  const clicked = await callTool("click", { tab_id: "t1", ref: bravoRef });
  assert.equal(clicked.isError, false, clicked.text);
  assert.equal(clicked.json?.clicked, true);

  const who = await callTool("evaluate", { tab_id: "t1", expression: "window.__clicked" });
  // The pre-fix ref walk numbered every visible node while the snapshot only
  // numbered emitted ones, so this landed on "Alpha" (or a filler div).
  assert.equal(who.json?.value, "b2", "clicked Bravo, not another element");
});

test("fill by ref sets the value the snapshot's textbox", async () => {
  await seedPage("t1");
  const snap = await callTool("get_snapshot", { tab_id: "t1" });
  const boxRef = refFor(snap.text, "Query box");

  const filled = await callTool("fill", { tab_id: "t1", ref: boxRef, value: "hello ref" });
  assert.equal(filled.isError, false, filled.text);
  assert.equal(filled.json?.filled, true);

  const val = await callTool("evaluate", { tab_id: "t1", expression: "document.getElementById('i1').value" });
  assert.equal(val.json?.value, "hello ref");

  // The new snapshot should surface the value back.
  const snap2 = await callTool("get_snapshot", { tab_id: "t1" });
  assert.match(snap2.text, /value="hello ref"/);
});

test("a ref invalidated by navigation reports an actionable error", async () => {
  await seedPage("t1");
  const snap = await callTool("get_snapshot", { tab_id: "t1" });
  const ref = refFor(snap.text, "Alpha");
  await callTool("navigate", { tab_id: "t1", url: "about:blank" });

  const r = await callTool("click", { tab_id: "t1", ref });
  assert.equal(r.isError, true, "stale ref is reported as an error");
  assert.match(r.text, /get_snapshot again/);
});

test("click_and_read returns the post-click snapshot in one call", async () => {
  await seedPage("t1");
  const snap = await callTool("get_snapshot", { tab_id: "t1" });
  const ref = refFor(snap.text, "Alpha");
  const r = await callTool("click_and_read", { tab_id: "t1", ref, settle_ms: 100 });
  assert.equal(r.json?.clicked, true);
  assert.match(r.json?.snapshot ?? "", /button "Bravo"/);
  const who = await callTool("evaluate", { tab_id: "t1", expression: "window.__clicked" });
  assert.equal(who.json?.value, "b1");
});

test("selector fallback still works and failures are explicit", async () => {
  await seedPage("t1");
  const ok = await callTool("click", { tab_id: "t1", selector: "#b2" });
  assert.equal(ok.json?.clicked, true);
  const who = await callTool("evaluate", { tab_id: "t1", expression: "window.__clicked" });
  assert.equal(who.json?.value, "b2");

  const miss = await callTool("click", { tab_id: "t1", selector: "#does-not-exist", timeout_ms: 700 });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /no element matched/);
});

test("bad arguments are rejected with a clear message", async () => {
  const noTarget = await callTool("click", { tab_id: "t1" });
  assert.equal(noTarget.isError, true);
  assert.match(noTarget.text, /ref .*or selector is required/);

  const badRegex = await callTool("wait_for_sso", { tab_id: "t1", sso_url_pattern: "([", wait_ms: 1000 });
  assert.equal(badRegex.isError, true);
  assert.match(badRegex.text, /not a valid regular expression/);

  const badTab = await callTool("evaluate", { tab_id: 42, expression: "1" });
  assert.equal(badTab.isError, true);
  assert.match(badTab.text, /tab_id must be a string/);
});

test("evaluate surfaces page exceptions instead of pretending success", async () => {
  const r = await callTool("evaluate", { tab_id: "t1", expression: "throw new Error('boom')" });
  assert.equal(r.isError, true);
  assert.match(r.text, /boom/);
});

test("wait_for_selector resolves and times out correctly", async () => {
  await seedPage("t1");
  const found = await callTool("wait_for_selector", { tab_id: "t1", selector: "#b1", timeout_ms: 3000 });
  assert.equal(found.json?.found, true);

  const started = Date.now();
  const missing = await callTool("wait_for_selector", { tab_id: "t1", selector: "#nope", timeout_ms: 1200 });
  assert.equal(missing.json?.found, false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1000 && elapsed < 8000, `waited ${elapsed}ms, expected ~1200ms`);
});

test("tabs keyed by tab_id stay isolated", async () => {
  await callTool("browser_launch", { tab_id: "t2" });
  await callTool("navigate", { tab_id: "t2", url: "about:blank" });

  await callTool("evaluate", { tab_id: "t1", expression: `window.__MARK = "A"` });
  await callTool("evaluate", { tab_id: "t2", expression: `window.__MARK = "B"` });

  const a = await callTool("evaluate", { tab_id: "t1", expression: "window.__MARK" });
  const b = await callTool("evaluate", { tab_id: "t2", expression: "window.__MARK" });
  assert.equal(a.json?.value, "A", "tab t1 kept its own value");
  assert.equal(b.json?.value, "B", "tab t2 kept its own value");

  const targets = await cdpTargets();
  assert.ok(targets !== null, "Chrome is running");
  assert.ok(targets.length >= 2, `t1/t2 各占一个标签页，实际 ${targets?.length}`);
});

test("concurrent calls for one tab_id do not open duplicate tabs", async () => {
  const before = await callTool("evaluate", {
    tab_id: "t1",
    expression: "1",
  });
  assert.equal(before.json?.ok, true);

  // Fire several calls at once for a fresh tab_id; only one tab should appear.
  const countTabs = async () => (await cdpTargets())?.length ?? 0;
  const baseline = await countTabs();
  await Promise.all([
    callTool("evaluate", { tab_id: "t3", expression: "1" }),
    callTool("evaluate", { tab_id: "t3", expression: "1" }),
    callTool("evaluate", { tab_id: "t3", expression: "1" }),
  ]);
  assert.equal(await countTabs(), baseline + 1, "the three racing calls shared one session");
  await callTool("browser_shutdown", { tab_id: "t3" });
});
