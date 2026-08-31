/**
 * High-level page operations built on top of CdpClient.
 *
 * Generic browser primitives only (navigate, evaluate JS in page context, read
 * a structured snapshot, click, fill, wait for SSO/login). All domain knowledge
 * lives in the companion Skill.
 *
 * ELEMENT REFS
 * ------------
 * `snapshot()` publishes the element behind every `[ref]` into a page-side
 * registry (`window.<REF_REGISTRY>`), and click/fill look the ref up there.
 * The previous implementation instead re-walked the DOM in click/fill and
 * re-derived ref numbers with a *different* rule than the snapshot used (the
 * snapshot only numbered nodes it decided to emit; the click walk numbered
 * every visible node), so `ref` routinely resolved to a different element than
 * the one the caller saw — silently clicking the wrong thing. Resolving through
 * a shared registry makes the two sides agree by construction, and is O(1)
 * instead of a full DOM walk per attempt.
 */
import { CdpClient } from "./cdp-client.js";
import { logger } from "../utils/logger.js";

export interface EvalResult<T = unknown> {
  value: T;
  /** Exception details if the script threw. */
  exceptionDetails?: string;
}

export interface RefActionResult {
  ok: boolean;
  /** Populated when the action could not be performed, for the LLM to act on. */
  error?: string;
}

/** Global the snapshot writes and click/fill read. */
const REF_REGISTRY = "__browserMcpRefs";

/** Safety cap on snapshot nodes, so a pathological page can't stall the walk. */
const MAX_SNAPSHOT_NODES = 4000;

export class PageOps {
  constructor(private cdp: CdpClient) {}

  /** Navigate the attached tab to a URL and wait for load. */
  async navigate(url: string, waitMs = 30000): Promise<void> {
    await this.cdp.ensureAttached();

    // Subscribe BEFORE issuing the navigation. The old order (navigate, then
    // subscribe) lost the load event for anything that loaded faster than the
    // CDP round-trip — about:blank and cached pages in particular — and then
    // burned the entire timeout waiting for an event that had already fired.
    const load = this.waitForLoadEvent(waitMs);
    let res: { errorText?: string; loaderId?: string };
    try {
      res = await this.cdp.sendSession<{ errorText?: string; loaderId?: string }>(
        "Page.navigate", { url }, waitMs + 5000
      );
    } catch (e) {
      load.cancel();
      throw e;
    }
    if (res?.errorText) {
      load.cancel();
      throw new Error(`Navigation to ${url} failed: ${res.errorText}`);
    }
    // CDP omits loaderId for a same-document navigation (e.g. adding/changing a
    // #fragment). Such a navigation never fires a load event, so waiting for one
    // burns the entire timeout — measured at the full 30s default before this
    // check existed.
    if (!res?.loaderId) {
      load.cancel();
      logger.debug(`navigate(${url}): same-document navigation, no load event expected`);
      return;
    }
    if (!(await load.promise)) logger.warn(`navigate(${url}): load event not seen within ${waitMs}ms`);
  }

  /** Wait until the document finishes loading (or timeout). Returns true if loaded. */
  async waitForLoad(timeoutMs = 30000): Promise<boolean> {
    await this.cdp.ensureAttached();
    // Already done? Don't wait for an event that will never come again.
    const ready = await this.evaluate<string>("document.readyState", false);
    if (ready.value === "complete") return true;
    const fired = await this.waitForLoadEvent(timeoutMs).promise;
    if (!fired) logger.warn("waitForLoad timed out");
    return fired;
  }

  /**
   * Event-driven load wait. Returns a handle so callers can subscribe first and
   * await later (avoiding the subscribe-after-navigate race).
   */
  private waitForLoadEvent(timeoutMs: number): { promise: Promise<boolean>; cancel: () => void } {
    let settle!: (fired: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { settle = resolve; });

    let done = false;
    let timer: NodeJS.Timeout;
    const finish = (fired: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.cdp.offEvent("Page.loadEventFired", handler);
      settle(fired);
    };
    const handler = (): void => finish(true);

    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    this.cdp.onEvent("Page.loadEventFired", handler);

    return { promise, cancel: () => finish(false) };
  }

  /** Current page URL. */
  async getUrl(): Promise<string> {
    const r = await this.evaluate<string>("location.href", false);
    return r.value ?? "";
  }

  /**
   * Evaluate an expression in the page context and return the JSON value.
   * `awaitPromise` lets the expression be an async/Promise-returning snippet.
   *
   * `cmdTimeoutMs` bounds the CDP request itself; it must exceed any in-page
   * wait loop, otherwise the transport gives up before the page does.
   */
  async evaluate<T = unknown>(
    expression: string,
    awaitPromise = true,
    cmdTimeoutMs?: number
  ): Promise<EvalResult<T>> {
    await this.cdp.ensureAttached();
    const res = await this.cdp.sendSession<{
      result?: { type: string; value?: any; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, cmdTimeoutMs);
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      return {
        value: undefined as unknown as T,
        exceptionDetails: ex.exception?.description ?? ex.text ?? "Unknown eval exception",
      };
    }
    return { value: res.result?.value as T };
  }

  /** Click an element matched by a CSS selector (via in-page JS). */
  async click(selector: string, timeoutMs = 10000): Promise<boolean> {
    const js = `
      (async () => {
        const sel = ${JSON.stringify(selector)};
        const start = Date.now();
        while (true) {
          const el = document.querySelector(sel);
          if (el) {
            el.scrollIntoView({block:'center'});
            if (typeof el.focus === 'function') el.focus();
            el.click();
            return true;
          }
          if (Date.now() - start >= ${timeoutMs}) return false;
          await new Promise(r => setTimeout(r, 100));
        }
      })()
    `;
    const r = await this.evaluate<boolean>(js, true, timeoutMs + 5000);
    if (r.exceptionDetails) throw new Error(`click(${selector}) failed: ${r.exceptionDetails}`);
    return r.value === true;
  }

  /**
   * Click an element by its [ref] number from the last snapshot, resolved via
   * the page-side ref registry.
   */
  async clickByRef(ref: number): Promise<RefActionResult> {
    const js = `
      (() => {
        const reg = window[${JSON.stringify(REF_REGISTRY)}];
        if (!Array.isArray(reg)) return { ok: false, error: 'stale' };
        const el = reg[${ref}];
        if (!el) return { ok: false, error: 'missing' };
        if (!el.isConnected) return { ok: false, error: 'detached' };
        el.scrollIntoView({block:'center'});
        if (typeof el.focus === 'function') el.focus();
        el.click();
        return { ok: true };
      })()
    `;
    return this.runRefAction(js, ref, "click");
  }

  /** Fill an input matched by selector. Returns true on success. */
  async fill(selector: string, value: string, timeoutMs = 10000): Promise<boolean> {
    const js = `
      (async () => {
        const sel = ${JSON.stringify(selector)};
        const val = ${JSON.stringify(value)};
        const start = Date.now();
        ${SET_VALUE_FN}
        while (true) {
          const el = document.querySelector(sel);
          if (el) { setValue(el, val); return true; }
          if (Date.now() - start >= ${timeoutMs}) return false;
          await new Promise(r => setTimeout(r, 100));
        }
      })()
    `;
    const r = await this.evaluate<boolean>(js, true, timeoutMs + 5000);
    if (r.exceptionDetails) throw new Error(`fill(${selector}) failed: ${r.exceptionDetails}`);
    return r.value === true;
  }

  /** Fill an input by its [ref] number (resolved via the ref registry). */
  async fillByRef(ref: number, value: string): Promise<RefActionResult> {
    const js = `
      (() => {
        const reg = window[${JSON.stringify(REF_REGISTRY)}];
        if (!Array.isArray(reg)) return { ok: false, error: 'stale' };
        const el = reg[${ref}];
        if (!el) return { ok: false, error: 'missing' };
        if (!el.isConnected) return { ok: false, error: 'detached' };
        ${SET_VALUE_FN}
        el.scrollIntoView({block:'center'});
        setValue(el, ${JSON.stringify(value)});
        return { ok: true };
      })()
    `;
    return this.runRefAction(js, ref, "fill");
  }

  /** Shared plumbing for ref-based actions, including stale-ref diagnostics. */
  private async runRefAction(js: string, ref: number, verb: string): Promise<RefActionResult> {
    const r = await this.evaluate<{ ok: boolean; error?: string }>(js, false);
    if (r.exceptionDetails) return { ok: false, error: `${verb} by ref ${ref} threw: ${r.exceptionDetails}` };
    const v = r.value;
    if (v?.ok) return { ok: true };
    switch (v?.error) {
      case "stale":
        return {
          ok: false,
          error:
            `No ref registry on this page — the page navigated or reloaded since the last ` +
            `get_snapshot. Call get_snapshot again and retry with a fresh ref.`,
        };
      case "missing":
        return { ok: false, error: `ref ${ref} is not in the latest snapshot. Call get_snapshot again.` };
      case "detached":
        return {
          ok: false,
          error:
            `ref ${ref} pointed at an element that has been removed from the DOM ` +
            `(the page re-rendered). Call get_snapshot again and retry.`,
        };
      default:
        return { ok: false, error: `${verb} by ref ${ref} did not succeed` };
    }
  }

  /**
   * Return a structured accessibility-style snapshot of the page, with a [ref]
   * number on each interactive/visible node so the LLM can click/fill by ref.
   * Falls back to innerText if the structured extraction fails.
   *
   * Cost notes: visibility uses `Element.checkVisibility()` when available
   * instead of a `getComputedStyle()` call per element (the old approach forced
   * style resolution for the whole tree, which dominated snapshot time on large
   * pages), and pure-wrapper containers with no text of their own are dropped
   * rather than emitted — those lines were the bulk of the output and used to
   * push the actually-interactive elements past the truncation cutoff.
   */
  async snapshot(maxChars = 20000): Promise<string> {
    const js = buildSnapshotScript();
    try {
      const r = await this.evaluate<SnapshotPayload>(js, false);
      if (r.exceptionDetails) {
        logger.warn(`structured snapshot threw: ${r.exceptionDetails}`);
      } else if (r.value && Array.isArray(r.value.lines)) {
        return formatSnapshot(r.value, maxChars);
      }
    } catch (e) {
      logger.warn("structured snapshot failed, falling back to innerText", e);
    }
    // Fallback: raw innerText.
    const fb = `document.body ? document.body.innerText.slice(0, ${maxChars}) : ''`;
    const r2 = await this.evaluate<string>(fb, false);
    return r2.value ?? "";
  }

  /**
   * Wait for an SSO/redirect login to settle: poll until the URL no longer
   * looks like an SSO gateway page and the body has meaningful content.
   *
   * One CDP round-trip per poll (was two: url and body length were fetched
   * separately), and evaluation errors during a redirect — the execution
   * context is destroyed mid-navigation — are treated as "still redirecting"
   * rather than aborting the wait.
   */
  async waitForSsoSettled(
    options: { timeoutMs?: number; ssoUrlPattern?: RegExp; minBodyLen?: number; deadline?: number } = {}
  ): Promise<{ url: string; ok: boolean }> {
    await this.cdp.ensureAttached();
    const ssoPattern = options.ssoUrlPattern ?? /sso|login|passport|auth\/oauth/i;
    const minLen = options.minBodyLen ?? 50;
    const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? 60000);
    const probe = `(() => ({ url: location.href, len: document.body ? document.body.innerText.length : 0 }))()`;

    let lastUrl = "";
    for (;;) {
      let state: { url: string; len: number } | undefined;
      try {
        const res = await this.evaluate<{ url: string; len: number }>(probe, false);
        if (!res.exceptionDetails) state = res.value;
      } catch (e) {
        // Context destroyed mid-redirect — expected during SSO hops.
        logger.debug("SSO probe failed (likely mid-navigation)", e);
      }
      if (state) {
        lastUrl = state.url;
        if (!ssoPattern.test(state.url) && state.len > minLen) return { url: state.url, ok: true };
      }
      if (Date.now() >= deadline) return { url: lastUrl, ok: false };
      await sleep(Math.min(1000, Math.max(50, deadline - Date.now())));
    }
  }

  /** Wait until a selector appears in the DOM. */
  async waitForSelector(selector: string, timeoutMs = 15000): Promise<boolean> {
    const js = `
      (async () => {
        const sel = ${JSON.stringify(selector)};
        const start = Date.now();
        while (true) {
          if (document.querySelector(sel)) return true;
          if (Date.now() - start >= ${timeoutMs}) return false;
          await new Promise(r => setTimeout(r, 100));
        }
      })()
    `;
    const r = await this.evaluate<boolean>(js, true, timeoutMs + 5000);
    if (r.exceptionDetails) throw new Error(`wait_for_selector(${selector}) failed: ${r.exceptionDetails}`);
    return r.value === true;
  }
}

// ---- in-page snippets ----

/**
 * Value setter shared by fill/fillByRef. Goes through the prototype's native
 * setter so React/Vue controlled inputs observe the change, and supports
 * contenteditable and checkbox/radio, which the old selector-only path ignored.
 */
const SET_VALUE_FN = `
  function setValue(el, val) {
    if (typeof el.focus === 'function') el.focus();
    if (el.isContentEditable) {
      el.textContent = val;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      return;
    }
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      const want = val === 'true' || val === '1' || val === 'on';
      if (el.checked !== want) el.click();
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
`;

interface SnapshotPayload {
  title: string;
  url: string;
  lines: string[];
  nodeCount: number;
  capped: boolean;
}

function buildSnapshotScript(): string {
  return `
    (() => {
      const REG = ${JSON.stringify(REF_REGISTRY)};
      const MAX_NODES = ${MAX_SNAPSHOT_NODES};
      // Index 0 unused so refs start at 1, matching the printed [N].
      const registry = [null];
      window[REG] = registry;

      const lines = [];
      let capped = false;

      const INTERACTIVE_ROLES = new Set([
        'link','button','textbox','searchbox','combobox','listbox','option',
        'menuitem','menuitemcheckbox','menuitemradio','tab','treeitem',
        'checkbox','radio','switch','spinbutton','slider',
      ]);
      const LANDMARK_ROLES = new Set([
        'heading','navigation','search','form','dialog','alertdialog','alert','banner',
        'table','row','cell','listitem','img','article',
      ]);
      const SKIP_TAGS = new Set(['script','style','noscript','template','head','link','meta','svg','canvas','iframe']);
      // Structural wrappers: only worth a line when they carry their own text.
      const GENERIC_TAGS = new Set(['div','span','p','section','label','td','th','li','em','strong','small','b','i']);

      function visible(el) {
        if (el.checkVisibility) {
          if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        } else {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
      }

      function roleOf(el, tag) {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit.trim().split(/\\s+/)[0];
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
        if (tag === 'button') return 'button';
        if (tag === 'input') {
          const t = (el.type || 'text').toLowerCase();
          if (t === 'hidden') return 'hidden';
          if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'search') return 'searchbox';
          if (t === 'range') return 'slider';
          if (t === 'number') return 'spinbutton';
          return 'textbox';
        }
        if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
        if (tag === 'option') return 'option';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'img') return 'img';
        if (tag === 'summary') return 'button';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'li') return 'listitem';
        if (tag === 'nav') return 'navigation';
        if (tag === 'form') return 'form';
        if (tag === 'table') return 'table';
        if (tag === 'tr') return 'row';
        if (tag === 'td' || tag === 'th') return 'cell';
        if (el.isContentEditable) return 'textbox';
        return tag;
      }

      /** Text belonging to THIS element, not to its descendants. */
      function ownText(el) {
        let s = '';
        for (const n of el.childNodes) {
          if (n.nodeType === 3) s += n.nodeValue;
        }
        return s.replace(/\\s+/g, ' ').trim();
      }

      function collapse(s) {
        return (s || '').replace(/\\s+/g, ' ').trim();
      }

      /**
       * Descendant text with word separation. Plain textContent would run
       * sibling elements together ("HomeSearch"); innerText would separate them
       * but forces layout for every node walked.
       */
      function descendantText(el, limit) {
        const parts = [];
        let len = 0;
        const visit = (node) => {
          if (len > limit) return;
          for (const n of node.childNodes) {
            if (n.nodeType === 3) {
              const t = n.nodeValue.replace(/\\s+/g, ' ').trim();
              if (t) { parts.push(t); len += t.length + 1; }
            } else if (n.nodeType === 1 && !SKIP_TAGS.has(n.tagName.toLowerCase())) {
              visit(n);
            }
            if (len > limit) return;
          }
        };
        visit(el);
        return parts.join(' ');
      }

      /**
       * useSubtree = the node is worth describing by its subtree (interactive
       * controls, headings, landmarks). Generic wrappers get ONLY their own
       * text, so a chain of nested divs no longer repeats the same sentence at
       * every level — that repetition was the bulk of the old output and it
       * pushed the real controls past the max_chars cutoff.
       */
      function nameOf(el, tag, useSubtree) {
        const aria = el.getAttribute('aria-label');
        if (aria) return collapse(aria);
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const parts = labelledBy.split(/\\s+/)
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map((n) => descendantText(n, 120));
          if (parts.length) return parts.join(' ');
        }
        for (const attr of ['alt','title','placeholder']) {
          const v = el.getAttribute(attr);
          if (v) return collapse(v);
        }
        if (el.id) {
          try {
            const lf = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (lf) return descendantText(lf, 120).slice(0, 120);
          } catch { /* id not usable in a selector */ }
        }
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          const lbl = el.closest('label');
          if (lbl) return descendantText(lbl, 120).slice(0, 120);
          return '';
        }
        const own = ownText(el);
        if (own) return own.slice(0, 160);
        if (useSubtree) return descendantText(el, 200).slice(0, 160);
        return '';
      }

      function extrasOf(el, tag, role) {
        let extras = '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          if (el.value) extras += ' value="' + String(el.value).slice(0, 80) + '"';
          if (el.disabled) extras += ' [disabled]';
          if (el.readOnly) extras += ' [readonly]';
          if (el.required) extras += ' [required]';
        }
        if (el.getAttribute('aria-expanded') !== null) extras += ' [expanded=' + el.getAttribute('aria-expanded') + ']';
        const checked = el.getAttribute('aria-checked') ?? (('checked' in el && (tag === 'input')) ? String(el.checked) : null);
        if (checked !== null && (role === 'checkbox' || role === 'radio' || role === 'switch')) {
          extras += ' [checked=' + checked + ']';
        }
        if (el.getAttribute('aria-selected') !== null) extras += ' [selected=' + el.getAttribute('aria-selected') + ']';
        if (tag === 'a' && el.href) extras += ' href="' + String(el.href).slice(0, 160) + '"';
        return extras;
      }

      function walk(el, depth) {
        if (registry.length > MAX_NODES) { capped = true; return; }
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return;
        if (!visible(el)) return;

        const role = roleOf(el, tag);
        if (role !== 'hidden') {
          const interactive = INTERACTIVE_ROLES.has(role);
          const landmark = LANDMARK_ROLES.has(role);
          const name = nameOf(el, tag, interactive || landmark);
          // Emit interactive nodes always (they're the point of the snapshot);
          // emit landmarks and generic containers only when they say something.
          const emit = interactive || ((landmark || GENERIC_TAGS.has(tag)) && !!name);
          if (emit) {
            const ref = registry.length;
            registry.push(el);
            const indent = '  '.repeat(Math.min(depth, 12));
            lines.push(indent + '[' + ref + '] ' + role + ' "' + name + '"' + extrasOf(el, tag, role));
          }
        }
        for (const child of el.children) walk(child, depth + 1);
      }

      if (document.body) walk(document.body, 0);
      return {
        title: document.title || '(untitled)',
        url: location.href,
        lines,
        nodeCount: registry.length - 1,
        capped,
      };
    })()
  `;
}

/** Format the payload, truncating on whole lines so no `[ref]` is cut in half. */
function formatSnapshot(p: SnapshotPayload, maxChars: number): string {
  const header = `PAGE: ${p.title}\nURL: ${p.url}\n\n`;
  const budget = Math.max(0, maxChars - header.length);
  const kept: string[] = [];
  let used = 0;
  for (const line of p.lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  let out = header + kept.join("\n");
  const dropped = p.lines.length - kept.length;
  if (dropped > 0) {
    out += `\n... [truncated: ${dropped} of ${p.lines.length} nodes omitted — raise max_chars, or use evaluate to query the page directly]`;
  }
  if (p.capped) {
    out += `\n... [page exceeded ${MAX_SNAPSHOT_NODES} nodes; the tail of the DOM was not walked]`;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
