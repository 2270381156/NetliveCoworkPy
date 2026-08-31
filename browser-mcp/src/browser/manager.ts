/**
 * CDP Browser Manager
 *
 * Launches (or reuses) a Chrome instance with remote-debugging on a fixed port
 * and a persistent user-data directory so SSO login state is retained across
 * sessions. The persistent profile works for any SSO-protected system, not just
 * a specific site — domain knowledge is provided by the companion Skill.
 */
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { logger } from "../utils/logger.js";

export interface LaunchOptions {
  /** Remote debugging port (default 9222). */
  port?: number;
  /** User-data dir for persistent profile (default: ~/.browser-mcp/chrome-profile). */
  userDataDir?: string;
  /** Chrome executable path. Auto-detected if omitted. */
  executablePath?: string;
  /** Extra URLs to open on launch. */
  startUrls?: string[];
}

export interface BrowserInfo {
  webSocketDebuggerUrl: string;
  port: number;
  pid: number;
}

/** A lock older than this is assumed abandoned by a crashed process. */
const LOCK_STALE_MS = 60_000;

export class CdpBrowserManager {
  private child: ChildProcess | null = null;
  private info: BrowserInfo | null = null;
  /** In-flight launch, shared by concurrent callers (see ensureLaunched). */
  private launching: Promise<BrowserInfo> | null = null;
  private lockHeld = false;
  private readonly defaultPort = 9222;
  private readonly lockFile: string;

  constructor() {
    const baseDir = join(homedir(), ".browser-mcp");
    this.lockFile = join(baseDir, "chrome.lock");
  }

  // ---- public API ----

  /**
   * Ensure a CDP Chrome is running and return its info. Idempotent.
   *
   * Concurrency: several tool calls can race here (two sessions calling
   * browser_launch at once). Previously each raced independently and the loser
   * died on "Another launch is in progress". Now the first caller's promise is
   * memoized and everyone awaits the same launch.
   */
  async ensureLaunched(opts: LaunchOptions = {}): Promise<BrowserInfo> {
    const port = opts.port ?? this.defaultPort;

    if (this.info) {
      if (this.info.port !== port) {
        logger.warn(
          `Chrome already running on port ${this.info.port}; ignoring requested port ${port}. ` +
          `Restart the MCP server to change ports.`
        );
      }
      return this.info;
    }
    if (this.launching) return this.launching;

    this.launching = this.doLaunch({ ...opts, port })
      .then((info) => {
        this.info = info;
        return info;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  /** Return current info or null. */
  getInfo(): BrowserInfo | null {
    return this.info;
  }

  /** Probe the port even when this process didn't launch Chrome itself. */
  async probe(port = this.defaultPort): Promise<BrowserInfo | null> {
    return this.tryProbeExisting(port);
  }

  /** Kill the Chrome we launched (not ones we reused). */
  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.info = null;
    this.releaseLock();
    if (!child) return;
    try {
      // Chrome spawns a process tree; `kill()` only signals the parent, which on
      // Windows leaves the renderer/GPU children (and the debugging port) alive.
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill();
      }
      logger.info("Chrome child process terminated");
    } catch (e) {
      logger.warn("Failed to kill Chrome child", e);
    }
  }

  // ---- internals ----

  private async doLaunch(opts: LaunchOptions & { port: number }): Promise<BrowserInfo> {
    const { port } = opts;

    // 1) Is something already listening on the port?
    const existing = await this.tryProbeExisting(port);
    if (existing) {
      logger.info(`Reusing existing CDP Chrome on port ${port}`);
      return existing;
    }

    // 2) Launch a fresh instance.
    return this.launchFresh(opts);
  }

  private async tryProbeExisting(port: number): Promise<BrowserInfo | null> {
    const url = `http://127.0.0.1:${port}/json/version`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { webSocketDebuggerUrl?: string } | null;
      if (data?.webSocketDebuggerUrl) {
        // We don't know the pid of a reused instance; use 0 as a sentinel.
        return { webSocketDebuggerUrl: data.webSocketDebuggerUrl, port, pid: 0 };
      }
    } catch {
      // not listening
    }
    return null;
  }

  private async launchFresh(opts: LaunchOptions & { port: number }): Promise<BrowserInfo> {
    const port = opts.port;
    const userDataDir = opts.userDataDir ?? join(homedir(), ".browser-mcp", "chrome-profile");
    mkdirSync(userDataDir, { recursive: true });

    const executablePath = opts.executablePath ?? this.detectChromePath();
    if (!executablePath || !existsSync(executablePath)) {
      throw new Error(
        `Chrome executable not found. Pass executablePath explicitly, or install Chrome/Edge. ` +
        `Tried: ${executablePath ?? "the standard install locations for " + process.platform}`
      );
    }

    // Cross-process lock so two MCP server processes don't launch Chrome onto
    // the same port/profile simultaneously.
    this.acquireLock(port);
    try {
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        // Chrome 111+ requires this to allow CDP WebSocket connections from
        // non-browser origins (e.g. Node.js ws client). Without it the WS
        // handshake is rejected with "Origin check failed" and every tool
        // that needs a page session fails with a socket error.
        "--remote-allow-origins=*",
        ...(opts.startUrls ?? []),
      ];

      logger.info(`Launching Chrome: ${executablePath} ${args.join(" ")}`);
      const child = spawn(executablePath, args, { detached: false, stdio: "ignore" });
      this.child = child;

      let spawnError: Error | null = null;
      child.on("error", (err) => {
        spawnError = err;
        logger.error("Chrome spawn error", err);
      });
      child.on("exit", (code, signal) => {
        logger.info(`Chrome process exited (code=${code} signal=${signal})`);
        if (this.child === child) {
          this.child = null;
          // Chrome is gone: drop the cached endpoint so the next call relaunches
          // instead of handing out a dead WebSocket URL.
          this.info = null;
        }
      });

      // Poll /json/version until ready.
      const info = await this.waitForReady(port, () => spawnError);
      return { ...info, port, pid: child.pid ?? 0 };
    } finally {
      // Previously the lock leaked whenever the readiness wait threw, which
      // permanently bricked every later launch attempt.
      this.releaseLock();
    }
  }

  private async waitForReady(
    port: number,
    getSpawnError: () => Error | null,
    timeoutMs = 30000
  ): Promise<{ webSocketDebuggerUrl: string }> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}/json/version`;
    while (Date.now() < deadline) {
      const spawnError = getSpawnError();
      if (spawnError) throw new Error(`Failed to start Chrome: ${spawnError.message}`);
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (resp.ok) {
          const data = (await resp.json()) as { webSocketDebuggerUrl?: string } | null;
          if (data?.webSocketDebuggerUrl) {
            return { webSocketDebuggerUrl: data.webSocketDebuggerUrl };
          }
        }
      } catch {
        // keep polling
      }
      await sleep(250);
    }
    throw new Error(
      `Chrome CDP endpoint not ready on port ${port} within ${timeoutMs}ms. ` +
      `Check that no other Chrome instance is using the same --user-data-dir.`
    );
  }

  private detectChromePath(): string | null {
    const platform = process.platform;
    const candidates: string[] = [];
    const envPath = process.env["BROWSER_MCP_CHROME_PATH"];
    if (envPath) candidates.push(envPath);
    if (platform === "win32") {
      const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
      const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
      const localAppData = process.env["LOCALAPPDATA"] ?? "";
      candidates.push(
        join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        localAppData ? join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
        join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    } else if (platform === "darwin") {
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      );
    } else {
      candidates.push(
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
      );
    }
    for (const c of candidates) {
      if (c && existsSync(c)) return c;
    }
    return null;
  }

  /**
   * Take the launch lock.
   *
   * Fixes over the old version: the create is atomic ("wx" fails if the file
   * exists, so two processes can't both think they won), and a lock left behind
   * by a crashed process is reclaimed instead of bricking launches forever.
   */
  private acquireLock(port: number): void {
    mkdirSync(dirname(this.lockFile), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockFile, "wx");
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, port, at: new Date().toISOString() }));
        } finally {
          closeSync(fd);
        }
        this.lockHeld = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (attempt === 1 || !this.reclaimStaleLock()) {
          throw new Error(
            `Another browser-mcp launch is in progress (lock: ${this.lockFile}). ` +
            `If no launch is running, delete that file and retry.`
          );
        }
      }
    }
  }

  /** Returns true if an abandoned lock was removed and we may retry. */
  private reclaimStaleLock(): boolean {
    try {
      const age = Date.now() - statSync(this.lockFile).mtimeMs;
      let ownerAlive = false;
      try {
        const { pid } = JSON.parse(readFileSync(this.lockFile, "utf8")) as { pid?: number };
        // signal 0 = liveness probe, sends nothing.
        if (typeof pid === "number" && pid !== process.pid) {
          try { process.kill(pid, 0); ownerAlive = true; } catch { ownerAlive = false; }
        }
      } catch {
        ownerAlive = false;
      }
      if (ownerAlive && age < LOCK_STALE_MS) return false;
      logger.warn(`Reclaiming stale launch lock (age ${Math.round(age / 1000)}s): ${this.lockFile}`);
      unlinkSync(this.lockFile);
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    try {
      if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
    } catch {
      // best effort
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
