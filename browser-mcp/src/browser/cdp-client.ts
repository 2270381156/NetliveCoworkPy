/**
 * Low-level CDP client.
 *
 * Connects to Chrome's remote-debugging WebSocket and exposes a minimal set of
 * page-automation primitives (navigate, evaluate JS, snapshot, click, fill,
 * wait). This replaces the dependency on a third-party playwright-cdp MCP by
 * talking the Chrome DevTools Protocol directly over WebSocket.
 *
 * Reliability rules enforced here:
 *   - Every command has a deadline. A CDP request that never gets a reply
 *     (renderer hung, target crashed, tab closed mid-flight) rejects instead of
 *     leaving the caller — and the MCP client waiting on it — hung forever.
 *   - Socket death rejects every in-flight command with an actionable message.
 *   - Events are routed by sessionId so a stray event from another target can
 *     never satisfy this session's wait.
 */
import WebSocket from "ws";
import { logger } from "../utils/logger.js";

type PendingEntry = {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export type CdpEventHandler = (params: any) => void;

const CONNECT_TIMEOUT_MS = 10_000;
/** Default per-command deadline. Long-running waits pass their own. */
const DEFAULT_COMMAND_TIMEOUT_MS = 35_000;

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private eventHandlers = new Map<string, Set<CdpEventHandler>>();
  /** sessionId of the currently attached page target (flattened session). */
  private sessionId: string | null = null;
  /** targetId of the tab we OWN (created by us). Survives WS reconnect. */
  private ourTargetId: string | null = null;
  /** Set once the socket is gone for good, so we fail fast with context. */
  private deadReason: string | null = null;

  constructor(private endpoint: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint);
      this.ws = ws;
      this.deadReason = null;

      // Guard so a post-handshake error can't re-settle this promise (it must
      // instead tear down in-flight commands — see failAllPending).
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve();
        return true;
      };

      // Timeout: if Chrome's WS endpoint is unreachable (e.g. missing
      // --remote-allow-origins, port conflict, Chrome crashed), fail fast
      // with an actionable message instead of hanging silently.
      const timeout = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        settle(new Error(
          `CDP WebSocket connect timeout (${CONNECT_TIMEOUT_MS}ms) to ${this.endpoint}. ` +
          `Most likely causes: Chrome not started, port busy, or ` +
          `missing --remote-allow-origins=* launch flag (Chrome 111+).`
        ));
      }, CONNECT_TIMEOUT_MS);

      ws.on("open", () => settle());
      ws.on("message", (raw: Buffer | string) => this.handleMessage(raw));
      ws.on("error", (err) => {
        logger.error("CDP ws error", err);
        const wrapped = new Error(
          `CDP WebSocket connection failed: ${err.message}. ` +
          `If Chrome is running, ensure it was launched with ` +
          `--remote-allow-origins=* (Chrome 111+ origin check).`
        );
        // Before the handshake: reject connect(). After it: kill in-flight work.
        if (!settle(wrapped)) this.markDead(wrapped.message);
      });
      ws.on("close", () => {
        logger.info("CDP ws closed");
        if (!settle(new Error(`CDP WebSocket closed before handshake completed (${this.endpoint})`))) {
          this.markDead("CDP WebSocket closed (Chrome exited, tab crashed, or endpoint went away)");
        }
      });
    });
  }

  async close(): Promise<void> {
    this.eventHandlers.clear();
    this.failAllPending(new Error("CDP client closed locally"));
    const ws = this.ws;
    this.ws = null;
    this.sessionId = null;
    this.deadReason = "CDP client closed locally";
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    // ws.close() is fire-and-forget; wait (briefly) for the actual close so a
    // shutdown sequence doesn't leave a half-open socket behind.
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } resolve(); }, 2000);
      ws.once("close", done);
      try { ws.close(); } catch { done(); }
    });
  }

  /**
   * Close the tab we created (if any) and reset ownership tracking.
   * Call this on graceful shutdown so we don't leak tabs.
   */
  async closeOurTab(): Promise<void> {
    if (this.ourTargetId && this.isOpen()) {
      try {
        await this.send("Target.closeTarget", { targetId: this.ourTargetId }, 5000);
      } catch {
        // best effort — tab may already be gone
      }
    }
    this.ourTargetId = null;
    this.sessionId = null;
  }

  /**
   * Attach to a page tab and store its session.
   *
   * Concurrency-safe: we NEVER attach to an existing tab that belongs to
   * another MCP process.  Instead, we always create a brand-new tab and own
   * it.  This prevents multiple concurrent sessions from stomping each
   * other's page (session A navigates to one site, session B to another, both
   * attached to the same tab → chaos).
   *
   * On reconnect (WS dropped then re-established) we try to re-attach to the
   * tab we previously created (`ourTargetId`).  If that tab is gone (user
   * closed it, Chrome restarted), we create a fresh one.
   */
  async attachToTarget(): Promise<{ targetId: string; sessionId: string }> {
    const targetId = (await this.resolveOwnedTarget()) ?? (await this.createOwnTab());

    const attached = await this.send<{ sessionId: string }>(
      "Target.attachToTarget", { targetId, flatten: true }
    );

    this.sessionId = attached.sessionId;

    // Enable page + runtime domains within this session.
    await this.sendSession("Page.enable");
    await this.sendSession("Runtime.enable");
    await this.sendSession("DOM.enable");

    return { targetId, sessionId: attached.sessionId };
  }

  /** Returns our previously-created tab if it still exists, else null. */
  private async resolveOwnedTarget(): Promise<string | null> {
    if (!this.ourTargetId) return null;
    const { targetInfos } = await this.send<{
      targetInfos: Array<{ targetId: string; type: string }>;
    }>("Target.getTargets", {});
    const alive = targetInfos.some((t) => t.targetId === this.ourTargetId && t.type === "page");
    return alive ? this.ourTargetId : null;
  }

  private async createOwnTab(): Promise<string> {
    const created = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    this.ourTargetId = created.targetId;
    return created.targetId;
  }

  /** Ensure we have a target; attach lazily if needed. */
  async ensureAttached(): Promise<void> {
    if (!this.sessionId) await this.attachToTarget();
  }

  onEvent(method: string, handler: CdpEventHandler): void {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
  }

  offEvent(method: string, handler: CdpEventHandler): void {
    const set = this.eventHandlers.get(method);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.eventHandlers.delete(method);
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** The targetId of the tab we own (for reconnect scenarios). */
  get ownedTargetId(): string | null {
    return this.ourTargetId;
  }

  /** Set the targetId we should own (used during reconnect to preserve tab). */
  setOwnedTargetId(id: string | null): void {
    this.ourTargetId = id;
  }

  /** Whether the underlying WebSocket is open and usable. */
  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Send a browser-level CDP command (no session). */
  async send<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    return this.rawSend<T>(method, params, undefined, timeoutMs);
  }

  /** Send a command scoped to the attached page session. */
  async sendSession<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (!this.sessionId) throw new Error("No target session. Call attachToTarget() first.");
    return this.rawSend<T>(method, params, this.sessionId, timeoutMs);
  }

  private rawSend<T>(
    method: string,
    params: unknown,
    sessionId: string | undefined,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(
        `CDP socket not open (${this.deadReason ?? "never connected"}); cannot send ${method}`
      ));
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      // A CDP command with no reply used to hang forever. Bound it.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify(payload), (err) => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            reject(new Error(`Failed to send CDP ${method}: ${err.message}`));
          }
        }
      });
    });
  }

  private markDead(reason: string): void {
    this.deadReason = reason;
    this.sessionId = null;
    this.failAllPending(new Error(reason));
  }

  /** Reject every in-flight command. Without this they hang until the client gives up. */
  private failAllPending(err: Error): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${err.message} (while awaiting ${entry.method})`));
    }
  }

  private handleMessage(raw: Buffer | string): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(
          `CDP ${p.method} failed: ${msg.error.message}` +
          (msg.error.data ? ` | ${JSON.stringify(msg.error.data)}` : "")
        ));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (!msg.method) return;
    // Route by session: browser-level events carry no sessionId; page events
    // must match OUR session, or an event from an unrelated target could
    // satisfy a wait (e.g. another tab's Page.loadEventFired).
    if (msg.sessionId && msg.sessionId !== this.sessionId) return;
    const handlers = this.eventHandlers.get(msg.method);
    if (!handlers) return;
    for (const h of [...handlers]) {
      try { h(msg.params); } catch (e) { logger.warn("event handler error", e); }
    }
  }
}
