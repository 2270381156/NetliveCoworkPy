/**
 * MCP tool definitions (schemas) for the generic browser-automation MCP.
 *
 * This MCP provides ONLY generic browser primitives — it has zero domain
 * knowledge. It does NOT know any website URLs, SSO patterns, or page quirks.
 * ALL domain knowledge MUST be supplied by a companion Skill. This MCP must
 * be used together with a Skill; without one, the tools have no context to
 * operate in. The Skill is not fixed to any single domain — any skill that
 * needs browser automation can pair with this MCP.
 *
 * MULTI-TAB CONCURRENCY: every tool accepts an optional `tab_id` parameter.
 * Each distinct tab_id maps to an independent browser tab + CDP session, so
 * multiple concurrent sessions (different chat windows) can each operate on
 * their own tab without stomping each other.  If tab_id is omitted, the
 * "default" slot is used (safe for single-session use, but NOT safe for
 * concurrent use — always pass a unique tab_id per session).
 *
 * Tools are grouped:
 *   - browser lifecycle: browser_launch, browser_shutdown
 *   - page navigation:   navigate, open_and_search (composite: navigate + SSO + snapshot)
 *   - page reading:      get_snapshot
 *   - page interaction:  click, click_and_read (composite), fill, evaluate
 *   - waiting:           wait_for_sso, wait_for_selector
 *
 * Every name here MUST have a matching case in tools/handler.ts — that pairing
 * is asserted at startup by assertToolsImplemented().
 */
import { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Shared tab_id property added to every tool schema. */
const TAB_ID_PROP = {
  type: "string",
  // 只留可执行指令；完整的多标签会话模型见本文件头注释与 README——那段解释放在这里会被
  // 11 个工具逐字重复 11 遍（占整个工具面 ~22% 的预算），而模型只需要知道"各用各的 id"。
  description:
    "Session's tab id — each concurrent session MUST use its own; omitted = shared 'default' (unsafe when concurrent).",
} as const;

const REF_PROP = {
  type: "number",
  description:
    "Ref number from this tab's latest get_snapshot (preferred over selector); if reported stale, snapshot again.",
} as const;

const SELECTOR_PROP = {
  type: "string",
  description: "CSS selector (fallback used only when ref is not provided).",
} as const;

const MAX_CHARS_PROP = {
  type: "number",
  default: 20000,
  description: "Max characters of snapshot text to return.",
} as const;

export const TOOL_DEFINITIONS: Tool[] = [
  // ---- browser lifecycle ----
  {
    name: "browser_launch",
    description:
      "Launch (or reuse) a CDP Chrome instance with a persistent user-data directory so SSO login state is retained. Creates a dedicated browser tab for the given tab_id and returns the tab_id. ALWAYS pass a unique tab_id for concurrent sessions.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        port: { type: "number", default: 9222, description: "Remote debugging port. Ignored if Chrome is already running on another port." },
        start_url: { type: "string", description: "Optional URL to navigate this tab_id's tab to right after it is created" },
      },
    },
  },
  {
    name: "browser_shutdown",
    description:
      "Close ONLY the caller's browser tab (identified by tab_id) and disconnect its CDP session. Does NOT kill the shared Chrome process or affect other sessions' tabs. Never launches a browser. Always pass your tab_id.",
    inputSchema: { type: "object", properties: { tab_id: TAB_ID_PROP } },
  },

  // ---- page navigation ----
  {
    name: "navigate",
    description:
      "Navigate the caller's tab to a URL and wait for the load event. Use open_and_search instead when you also need SSO handling and a snapshot — it does all three in one call.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        url: { type: "string", description: "Target URL" },
        wait_ms: { type: "number", default: 30000, description: "Max ms to wait for the load event" },
      },
      required: ["url"],
    },
  },

  // ---- page reading ----
  {
    name: "get_snapshot",
    description:
      "Return a STRUCTURED accessibility-tree snapshot of the caller's tab. Each interactive/visible node is shown as '[ref] role \"name\" extras', where [ref] is an integer you can pass directly to the `click`/`fill` tools' `ref` parameter — no need to guess CSS selectors. The top of the output includes PAGE title and URL. Refs are only valid until the page navigates or re-renders; take a fresh snapshot after either. If structured extraction fails it falls back to raw innerText. Use max_chars to cap output length.",
    inputSchema: {
      type: "object",
      properties: { tab_id: TAB_ID_PROP, max_chars: MAX_CHARS_PROP },
    },
  },

  // ---- page interaction ----
  {
    name: "click",
    description:
      "Click an element on the caller's tab (identified by tab_id). Prefer passing `ref` (the [N] number from get_snapshot) — it targets exactly the element you saw and avoids selector guesswork. Falls back to `selector` (CSS) if ref is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        ref: REF_PROP,
        selector: SELECTOR_PROP,
        timeout_ms: { type: "number", default: 10000, description: "Max ms to wait for a selector match (ignored for ref)" },
      },
    },
  },
  {
    name: "click_and_read",
    description:
      "Composite tool: click an element + return a structured snapshot of the page after the click — all in one call. Saves 1 LLM round-trip vs calling click then get_snapshot separately. Use this after interactions that change the page (search buttons, expand/collapse, pagination, tab switches). Waits settle_ms (default 500) after the click for SPA async content before snapshotting.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        ref: REF_PROP,
        selector: SELECTOR_PROP,
        timeout_ms: { type: "number", default: 10000, description: "Max ms to wait for a selector match (ignored for ref)" },
        settle_ms: { type: "number", default: 500, description: "Ms to wait after the click before snapshotting (raise for slow SPAs)" },
        max_chars: MAX_CHARS_PROP,
      },
    },
  },
  {
    name: "fill",
    description:
      "Fill an input element on the caller's tab with a value, firing input/change events so framework-controlled inputs (React/Vue) observe it. Also handles contenteditable and checkbox/radio ('true'/'false'). Prefer passing `ref` (the [N] number from get_snapshot); falls back to `selector`.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        ref: REF_PROP,
        selector: SELECTOR_PROP,
        value: { type: "string", description: "Value to set" },
        timeout_ms: { type: "number", default: 10000, description: "Max ms to wait for a selector match (ignored for ref)" },
      },
      required: ["value"],
    },
  },
  {
    name: "evaluate",
    description:
      "Evaluate a JavaScript expression in the caller's tab and return the JSON-serializable result. Use this for custom DOM queries, extracting data, or running page-specific logic. The expression may be async (awaitPromise is on). Returns ok:false plus the exception text if the expression throws.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        expression: { type: "string", description: "JavaScript expression to evaluate in the page" },
        timeout_ms: { type: "number", default: 35000, description: "Max ms to wait for the expression to settle" },
      },
      required: ["expression"],
    },
  },

  // ---- waiting ----
  {
    name: "wait_for_sso",
    description:
      "Wait for an SSO/redirect login to settle on the caller's tab: polls until the URL no longer matches the SSO pattern AND the page has real content. Returns {settled, url}. The SSO URL pattern is domain knowledge — pass it from your Skill via sso_url_pattern.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        sso_url_pattern: { type: "string", description: "Regex (string) matching SSO/login URLs. Omit to use the default pattern (sso|login|passport|auth/oauth)." },
        wait_ms: { type: "number", default: 60000, description: "Max ms to wait" },
        min_body_len: { type: "number", default: 50, description: "Minimum body innerText length that counts as 'real content'" },
      },
    },
  },
  {
    name: "wait_for_selector",
    description:
      "Wait until a CSS selector matches an element in the caller's tab. Returns {found}. Use this instead of polling with evaluate when waiting for async content to appear.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        selector: { type: "string", description: "CSS selector to wait for" },
        timeout_ms: { type: "number", default: 15000, description: "Max ms to wait" },
      },
      required: ["selector"],
    },
  },

  // ---- composite tool (saves 2-3 round-trips) ----
  {
    name: "open_and_search",
    description:
      "Composite tool: navigate to a URL + wait for SSO to settle + return a structured snapshot — all in one call. Saves 2-3 LLM round-trips vs calling navigate, wait_for_sso, get_snapshot separately. wait_ms is the budget for the WHOLE call, not per step. Always returns a snapshot (even if SSO didn't settle, so you can see the login page and tell the user to log in). Use this as the FIRST step when opening any system for search. If sso_settled is false, the snapshot shows the SSO login page — stop and ask the user to log in.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: TAB_ID_PROP,
        url: { type: "string", description: "Target URL to navigate to" },
        sso_url_pattern: { type: "string", description: "Regex (string) matching SSO/login URLs. Omit to use the default pattern (sso|login|passport|auth/oauth)." },
        skip_sso: { type: "boolean", default: false, description: "If true, skip the SSO wait entirely (for sites that don't use SSO)" },
        wait_ms: { type: "number", default: 60000, description: "Total ms budget for page load + SSO wait" },
        max_chars: MAX_CHARS_PROP,
      },
      required: ["url"],
    },
  },
];
