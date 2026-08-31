/**
 * Argument coercion helpers.
 *
 * MCP clients are not guaranteed to honour a JSON-Schema `type` — a number can
 * arrive as "9222" and a boolean as "true". Casting with `as number` (the old
 * approach) let those slip through and blow up deep inside CDP with an opaque
 * error. These helpers coerce + validate once, at the edge.
 */

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`Parameter "${key}" must be a string (got ${typeof v})`);
  return v;
}

export function reqString(args: Record<string, unknown>, key: string): string {
  const v = optString(args, key);
  if (v === undefined || v === "") throw new Error(`Parameter "${key}" is required`);
  return v;
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Parameter "${key}" must be a number (got ${JSON.stringify(v)})`);
  return n;
}

/** Positive-integer parameter with a default and an inclusive upper bound. */
export function optDuration(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max = 600_000
): number {
  const n = optNumber(args, key);
  if (n === undefined) return fallback;
  if (n <= 0) throw new Error(`Parameter "${key}" must be > 0`);
  return Math.min(Math.floor(n), max);
}

export function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const n = optNumber(args, key);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) throw new Error(`Parameter "${key}" must be an integer (got ${n})`);
  return n;
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`Parameter "${key}" must be a boolean (got ${JSON.stringify(v)})`);
}

/** Compile a user-supplied regex string, turning a bad pattern into a clear error. */
export function optRegex(args: Record<string, unknown>, key: string, flags = "i"): RegExp | undefined {
  const src = optString(args, key);
  if (src === undefined) return undefined;
  try {
    return new RegExp(src, flags);
  } catch (e) {
    throw new Error(`Parameter "${key}" is not a valid regular expression: ${(e as Error).message}`);
  }
}
