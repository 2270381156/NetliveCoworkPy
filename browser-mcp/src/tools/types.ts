/** Shared session types (previously duplicated in handler.ts and index.ts). */
import { CdpClient } from "../browser/cdp-client.js";
import { PageOps } from "../browser/page-ops.js";

export interface SessionSlot {
  cdp: CdpClient;
  page: PageOps;
}

/** Creates the tab/CDP session on demand for the current tab_id. */
export type EnsureSession = () => Promise<SessionSlot>;

/** Returns the existing session for the current tab_id, without creating one. */
export type PeekSession = () => SessionSlot | undefined;

export interface ToolContext {
  ensureSession: EnsureSession;
  peekSession: PeekSession;
  /** tab_ids with a live session, for browser_status. */
  activeTabIds: () => string[];
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};
