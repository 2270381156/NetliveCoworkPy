/**
 * Tool execution logic — dispatches tool calls to browser/page operations and
 * formats results as MCP content blocks.
 */
import { CdpBrowserManager } from "../browser/manager.js";
import { logger } from "../utils/logger.js";
import { optBool, optDuration, optInt, optNumber, optRegex, optString, reqString } from "../utils/args.js";
import { TOOL_DEFINITIONS } from "./definitions.js";
import type { RefActionResult } from "../browser/page-ops.js";
import type { ToolContext, ToolResult } from "./types.js";

/** Handlers keyed by tool name, so dispatch and the schema list can be cross-checked. */
const HANDLERS: Record<
  string,
  (args: Record<string, unknown>, manager: CdpBrowserManager, ctx: ToolContext) => Promise<ToolResult>
> = {
  // ---- browser lifecycle ----
  browser_launch: (a, m, c) => handleBrowserLaunch(a, m, c),
  browser_shutdown: (a, _m, c) => handleBrowserShutdown(a, c),

  // ---- navigation / reading ----
  navigate: (a, _m, c) => handleNavigate(a, c),
  get_snapshot: (a, _m, c) => handleGetSnapshot(a, c),

  // ---- interaction ----
  click: (a, _m, c) => handleClick(a, c),
  click_and_read: (a, _m, c) => handleClickAndRead(a, c),
  fill: (a, _m, c) => handleFill(a, c),
  evaluate: (a, _m, c) => handleEvaluate(a, c),

  // ---- waiting ----
  wait_for_sso: (a, _m, c) => handleWaitForSso(a, c),
  wait_for_selector: (a, _m, c) => handleWaitForSelector(a, c),

  // ---- composite (saves multiple round-trips) ----
  open_and_search: (a, _m, c) => handleOpenAndSearch(a, c),
};

/**
 * Fail at startup if a declared tool has no handler (or vice versa).
 *
 * This existed as a latent bug: `get_snapshot` was advertised in tools/list but
 * had no case in the dispatch switch, so every call returned the plain text
 * "Unknown tool: get_snapshot" — no error flag, no log — and the primary way to
 * read a page was silently dead.
 */
export function assertToolsImplemented(): void {
  const declared = new Set(TOOL_DEFINITIONS.map((t) => t.name));
  const implemented = new Set(Object.keys(HANDLERS));
  const missing = [...declared].filter((n) => !implemented.has(n));
  const orphaned = [...implemented].filter((n) => !declared.has(n));
  const problems: string[] = [];
  if (missing.length) problems.push(`declared without a handler: ${missing.join(", ")}`);
  if (orphaned.length) problems.push(`handled but not declared: ${orphaned.join(", ")}`);
  if (problems.length) throw new Error(`Tool registry mismatch — ${problems.join("; ")}`);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  manager: CdpBrowserManager,
  ctx: ToolContext
): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) {
    return errorResult(`Unknown tool: ${name}. Available: ${Object.keys(HANDLERS).join(", ")}`);
  }
  try {
    return await handler(args, manager, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`tool ${name} failed`, err);
    return errorResult(`Error in ${name}: ${msg}`);
  }
}

// ---- helpers ----

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Errors carry isError so the client can distinguish them from page content. */
function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonResult(obj: unknown): ToolResult {
  return textResult(JSON.stringify(obj, null, 2));
}

/** Resolve the ref/selector pair once for click/fill/click_and_read. */
function resolveTarget(args: Record<string, unknown>): { ref: number } | { selector: string } {
  const ref = optInt(args, "ref");
  if (ref !== undefined) {
    if (ref < 1) throw new Error(`ref must be a positive integer (got ${ref})`);
    return { ref };
  }
  const selector = optString(args, "selector");
  if (!selector) throw new Error("either ref (from get_snapshot, preferred) or selector is required");
  return { selector };
}

function refOutcome(verb: string, ref: number, r: RefActionResult): ToolResult {
  // A stale ref is a real failure the caller must react to (re-snapshot), not a
  // quiet `false` buried in a JSON blob.
  if (!r.ok) return errorResult(JSON.stringify({ [verb]: false, ref, error: r.error }, null, 2));
  return jsonResult({ [verb]: true, ref });
}

// ---- browser lifecycle handlers ----

async function handleBrowserLaunch(
  args: Record<string, unknown>,
  manager: CdpBrowserManager,
  ctx: ToolContext
): Promise<ToolResult> {
  const port = optNumber(args, "port");
  const startUrl = optString(args, "start_url");
  const tabId = optString(args, "tab_id") ?? "default";
  const info = await manager.ensureLaunched({ port });
  // ensureSession creates the per-tab CdpClient + attaches to a dedicated tab.
  const slot = await ctx.ensureSession();
  // start_url used to be passed as a Chrome command-line argument, so it opened
  // an extra tab that no session owned (leaked on shutdown) and left the
  // caller's own tab on about:blank. It also only took effect on a cold launch.
  // Navigating the caller's tab is what the parameter is actually for.
  if (startUrl) await slot.page.navigate(startUrl, 30000);
  return jsonResult({
    status: "launched",
    endpoint: info.webSocketDebuggerUrl,
    port: info.port,
    pid: info.pid,
    tab_id: tabId,
    target_id: slot.cdp.ownedTargetId,
    ...(startUrl ? { url: await slot.page.getUrl() } : {}),
  });
}

async function handleBrowserShutdown(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const tabId = optString(args, "tab_id") ?? "default";
  // Peek, never ensure: the old version called ensureSession(), so shutting
  // down an idle tab_id would launch Chrome and open a tab just to close it.
  const slot = ctx.peekSession();
  if (!slot) return jsonResult({ closed: false, tab_id: tabId, reason: "no open session for this tab_id" });
  try {
    await slot.cdp.closeOurTab();
  } catch (e) {
    logger.warn(`closeOurTab for ${tabId} failed`, e);
  }
  return jsonResult({ closed: true, tab_id: tabId });
}

// ---- navigation / reading handlers ----

async function handleNavigate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = reqString(args, "url");
  const waitMs = optDuration(args, "wait_ms", 30000);
  const { page } = await ctx.ensureSession();
  await page.navigate(url, waitMs);
  return jsonResult({ navigated: true, url: await page.getUrl() });
}

async function handleGetSnapshot(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const maxChars = optDuration(args, "max_chars", 20000, 500_000);
  const { page } = await ctx.ensureSession();
  return textResult(await page.snapshot(maxChars));
}

// ---- page interaction handlers ----

async function handleClick(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const target = resolveTarget(args);
  const timeout = optDuration(args, "timeout_ms", 10000);
  const { page } = await ctx.ensureSession();
  if ("ref" in target) return refOutcome("clicked", target.ref, await page.clickByRef(target.ref));
  const ok = await page.click(target.selector, timeout);
  return ok
    ? jsonResult({ clicked: true, selector: target.selector })
    : errorResult(JSON.stringify({ clicked: false, selector: target.selector, error: `no element matched within ${timeout}ms` }, null, 2));
}

/**
 * click_and_read: click + get_snapshot in one call.
 * Saves 1 LLM round-trip vs calling click then get_snapshot separately. Use
 * after interactions that change the page (search buttons, expand/collapse,
 * pagination, tab switches).
 */
async function handleClickAndRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const target = resolveTarget(args);
  const timeout = optDuration(args, "timeout_ms", 10000);
  const settleMs = optDuration(args, "settle_ms", 500, 30_000);
  const maxChars = optDuration(args, "max_chars", 20000, 500_000);
  const { page } = await ctx.ensureSession();

  // 1. Click — prefer ref over selector
  let clicked: boolean;
  let clickError: string | undefined;
  if ("ref" in target) {
    const r = await page.clickByRef(target.ref);
    clicked = r.ok;
    clickError = r.error;
  } else {
    clicked = await page.click(target.selector, timeout);
    if (!clicked) clickError = `no element matched "${target.selector}" within ${timeout}ms`;
  }

  // 2. Brief settle for SPA async load
  await sleep(settleMs);

  // 3. Snapshot — returned even on a failed click, so the caller can see why
  const snapshot = await page.snapshot(maxChars);

  return jsonResult({ clicked, ...(clickError ? { error: clickError } : {}), snapshot });
}

async function handleFill(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const value = optString(args, "value");
  if (value === undefined) return errorResult("Error: value is required");
  const target = resolveTarget(args);
  const timeout = optDuration(args, "timeout_ms", 10000);
  const { page } = await ctx.ensureSession();
  if ("ref" in target) return refOutcome("filled", target.ref, await page.fillByRef(target.ref, value));
  const ok = await page.fill(target.selector, value, timeout);
  return ok
    ? jsonResult({ filled: true, selector: target.selector })
    : errorResult(JSON.stringify({ filled: false, selector: target.selector, error: `no element matched within ${timeout}ms` }, null, 2));
}

async function handleEvaluate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const expression = reqString(args, "expression");
  const timeout = optDuration(args, "timeout_ms", 35000);
  const { page } = await ctx.ensureSession();
  const r = await page.evaluate(expression, true, timeout);
  if (r.exceptionDetails) return errorResult(JSON.stringify({ ok: false, exception: r.exceptionDetails }, null, 2));
  return jsonResult({ ok: true, value: r.value });
}

// ---- waiting handlers ----

async function handleWaitForSso(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const waitMs = optDuration(args, "wait_ms", 60000);
  const ssoUrlPattern = optRegex(args, "sso_url_pattern");
  const minBodyLen = optNumber(args, "min_body_len");
  const { page } = await ctx.ensureSession();
  const r = await page.waitForSsoSettled({ timeoutMs: waitMs, ssoUrlPattern, minBodyLen });
  return jsonResult({ settled: r.ok, url: r.url });
}

async function handleWaitForSelector(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const selector = reqString(args, "selector");
  const timeout = optDuration(args, "timeout_ms", 15000);
  const { page } = await ctx.ensureSession();
  const found = await page.waitForSelector(selector, timeout);
  return jsonResult({ found, selector });
}

// ---- composite handlers ----

/**
 * open_and_search: navigate + wait_for_sso + snapshot in one call.
 * Saves 2-3 LLM round-trips. If sso_url_pattern is provided, waits for SSO to
 * settle; if it does not settle, the snapshot is returned anyway so the LLM can
 * see the login page and tell the user to log in.
 */
async function handleOpenAndSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = reqString(args, "url");
  const waitMs = optDuration(args, "wait_ms", 60000);
  const maxChars = optDuration(args, "max_chars", 20000, 500_000);
  const ssoPattern = optRegex(args, "sso_url_pattern");
  const skipSso = optBool(args, "skip_sso") ?? false;
  const { page } = await ctx.ensureSession();

  // wait_ms is the budget for the WHOLE call. Previously navigate and the SSO
  // wait each got the full wait_ms, so a stuck login could block for 2×wait_ms.
  const deadline = Date.now() + waitMs;

  // 1. Navigate
  await page.navigate(url, waitMs);

  // 2. Wait for SSO unless skipped (or the budget is already gone)
  let ssoSettled = true;
  let finalUrl: string;
  if (skipSso) {
    finalUrl = await page.getUrl();
  } else {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      ssoSettled = false;
      finalUrl = await page.getUrl();
    } else {
      const sso = await page.waitForSsoSettled({ deadline, ssoUrlPattern: ssoPattern });
      ssoSettled = sso.ok;
      finalUrl = sso.url || (await page.getUrl());
    }
  }

  // 3. Snapshot — always returned, even if SSO didn't settle
  const snapshot = await page.snapshot(maxChars);

  return jsonResult({ navigated: true, url: finalUrl, sso_settled: ssoSettled, snapshot });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
