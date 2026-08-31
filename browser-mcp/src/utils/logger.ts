/**
 * Minimal logger that writes to stderr (stdout is reserved for MCP JSON-RPC).
 *
 * Level is controlled by BROWSER_MCP_LOG_LEVEL (silent|error|warn|info|debug),
 * default "info". Extras are truncated so a page snapshot or a long JS
 * expression can never flood the client's stderr pipe (a full pipe buffer
 * stalls the whole MCP server).
 */
type Level = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<Level, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const MAX_EXTRA_CHARS = 2000;

function resolveLevel(): Level {
  const raw = (process.env["BROWSER_MCP_LOG_LEVEL"] ?? "info").toLowerCase();
  return (raw in ORDER ? raw : "info") as Level;
}

const threshold = ORDER[resolveLevel()];

function emit(level: Exclude<Level, "silent">, msg: string, extra?: unknown): void {
  if (ORDER[level] > threshold) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) {
    process.stderr.write(`${line} ${truncate(safeStringify(extra))}\n`);
  } else {
    process.stderr.write(`${line}\n`);
  }
}

function truncate(s: string): string {
  return s.length > MAX_EXTRA_CHARS ? `${s.slice(0, MAX_EXTRA_CHARS)}… [+${s.length - MAX_EXTRA_CHARS} chars]` : s;
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export const logger = {
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
};

/**
 * Redact/shorten tool arguments before logging. `value` may be a password typed
 * into an SSO form and `expression` may be a multi-KB script — neither belongs
 * verbatim in a log.
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "value") {
      out[k] = typeof v === "string" ? `<${v.length} chars redacted>` : "<redacted>";
    } else if (typeof v === "string" && v.length > 200) {
      out[k] = `${v.slice(0, 200)}… [+${v.length - 200} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
