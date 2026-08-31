/**
 * Register all MCP tools on the server.
 *
 * MULTI-TAB SESSION MANAGEMENT
 * ----------------------------
 * One MCP server process may be shared across multiple concurrent client
 * sessions (e.g. the same stdio MCP configured once but used from several
 * chat sessions).  Each `tab_id` gets its own session slot: one CdpClient (one
 * WebSocket) owning one dedicated browser tab.  Every tool call should pass
 * `tab_id`; calls without one share the "default" slot.
 *
 * Slot creation is serialized per tab_id (see `pendingSessions`).  Without that,
 * two concurrent calls for the same tab_id both saw an empty map, both created a
 * CdpClient and a tab, and one of them was overwritten in the map — leaking a
 * WebSocket and an orphaned Chrome tab on every race.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CdpBrowserManager } from "../browser/manager.js";
import { CdpClient } from "../browser/cdp-client.js";
import { PageOps } from "../browser/page-ops.js";
import { logger, redactArgs } from "../utils/logger.js";
import { TOOL_DEFINITIONS } from "./definitions.js";
import { assertToolsImplemented, executeTool } from "./handler.js";
import type { SessionSlot, ToolContext } from "./types.js";

export interface ToolRegistration {
  /** Close every tab/socket this server opened. Used by the shutdown hooks. */
  disposeAll: () => Promise<void>;
}

export function registerTools(server: Server, manager: CdpBrowserManager): ToolRegistration {
  // Fail loudly at startup rather than at call time if schemas and handlers drift.
  assertToolsImplemented();

  const sessions = new Map<string, SessionSlot>();
  /** In-flight slot creations, keyed by tab_id, so concurrent calls share one. */
  const pendingSessions = new Map<string, Promise<SessionSlot>>();

  const createSession = async (tabId: string): Promise<SessionSlot> => {
    const info = await manager.ensureLaunched();
    const cdp = new CdpClient(info.webSocketDebuggerUrl);
    try {
      await cdp.connect();
      await cdp.attachToTarget();
    } catch (e) {
      // Never leave a half-built session in the map.
      await cdp.close().catch(() => {});
      throw e;
    }
    const slot: SessionSlot = { cdp, page: new PageOps(cdp) };
    sessions.set(tabId, slot);
    return slot;
  };

  const ensureSessionFor = async (tabId: string): Promise<SessionSlot> => {
    const existing = sessions.get(tabId);
    if (existing) {
      if (existing.cdp.isOpen()) return existing;
      logger.warn(`CDP socket for tab ${tabId} was closed, reconnecting…`);
      sessions.delete(tabId);
      // Remember the tab we owned so the reconnect re-attaches to it instead of
      // stranding it and opening yet another one.
      const previousTarget = existing.cdp.ownedTargetId;
      await existing.cdp.close().catch(() => {});
      const inflight = (pendingSessions.get(tabId) ?? createSession(tabId).finally(() => pendingSessions.delete(tabId)));
      pendingSessions.set(tabId, inflight);
      const slot = await inflight;
      if (previousTarget && !slot.cdp.ownedTargetId) slot.cdp.setOwnedTargetId(previousTarget);
      return slot;
    }
    const inflight = pendingSessions.get(tabId);
    if (inflight) return inflight;
    const created = createSession(tabId).finally(() => pendingSessions.delete(tabId));
    pendingSessions.set(tabId, created);
    return created;
  };

  const disposeSession = async (tabId: string): Promise<void> => {
    const slot = sessions.get(tabId);
    if (!slot) return;
    sessions.delete(tabId);
    try {
      await slot.cdp.closeOurTab();
    } catch { /* best effort */ }
    await slot.cdp.close().catch(() => {});
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    logger.info(`tool call: ${toolName}`, redactArgs(args));

    const rawTabId = args.tab_id;
    if (rawTabId !== undefined && rawTabId !== null && typeof rawTabId !== "string") {
      return {
        content: [{ type: "text" as const, text: `Error: tab_id must be a string (got ${typeof rawTabId})` }],
        isError: true,
      };
    }
    const tabId = rawTabId ?? "default";

    const ctx: ToolContext = {
      ensureSession: () => ensureSessionFor(tabId),
      peekSession: () => sessions.get(tabId),
      activeTabIds: () => [...sessions.keys()],
    };

    const result = await executeTool(toolName, args, manager, ctx);

    // Drop the slot after a shutdown so the socket and tab don't linger.
    if (toolName === "browser_shutdown") await disposeSession(tabId);

    return result;
  });

  return {
    disposeAll: async () => {
      await Promise.all([...sessions.keys()].map((id) => disposeSession(id).catch(() => {})));
    },
  };
}
