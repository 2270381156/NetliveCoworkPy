#!/usr/bin/env node
/**
 * Browser MCP - Entry point
 *
 * A generic browser-automation MCP server that launches a CDP Chrome instance
 * with a persistent user-data directory (to retain login state for any SSO-
 * protected system) and exposes browser-automation tools over MCP.
 *
 * IMPORTANT: This MCP is intentionally domain-agnostic — it only provides
 * generic browser primitives (navigate, click, fill, evaluate, snapshot,
 * wait_for_sso). ALL domain knowledge (target URLs, SSO URL patterns, page
 * structure quirks, search SOPs) MUST come from a companion Skill. This MCP
 * must be used together with a Skill; using it without one is not supported.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CdpBrowserManager } from "./browser/manager.js";
import { registerTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";

const VERSION = "0.3.0";

async function main(): Promise<void> {
  logger.info(`browser-mcp ${VERSION} starting`);

  const browserManager = new CdpBrowserManager();

  const server = new Server(
    { name: "browser-mcp", version: VERSION },
    { capabilities: { tools: {} } }
  );

  const { disposeAll } = registerTools(server, browserManager);

  // Without this, a client that kills the server (or a Ctrl-C) left every tab we
  // opened behind, plus a stale launch lock that blocked the next launch.
  installShutdownHooks(async () => {
    await disposeAll();
    await browserManager.shutdown();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("browser-mcp ready (stdio transport)");
}

function installShutdownHooks(cleanup: () => Promise<void>): void {
  let done = false;
  const run = async (signal: string): Promise<void> => {
    if (done) return;
    done = true;
    logger.info(`shutting down (${signal})`);
    try {
      await Promise.race([cleanup(), new Promise((r) => setTimeout(r, 5000))]);
    } catch (e) {
      logger.warn("cleanup failed", e);
    }
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => void run(sig));
  }
  // The client closing stdin is the normal "you're done" signal for stdio MCP.
  process.stdin.on("end", () => void run("stdin end"));
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
