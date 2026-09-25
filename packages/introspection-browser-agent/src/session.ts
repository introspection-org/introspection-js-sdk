import { CdpConnection, type CdpConnectOptions, type CdpEvent } from "./cdp.js";
import { MAX_PRESS_KEYS, parseChord } from "./keys.js";
import { PAGE_SCRIPT, PAGE_SCRIPT_VERSION } from "./page-script.js";
import { runDriverLadder, type RunOptions, type RunResult } from "./run.js";
import {
  BrowserError,
  type BrowserErrorCode,
  type BrowserEvent,
  type ElementAction,
  type Observation,
  type Screenshot,
  type TabInfo,
} from "./types.js";

export interface BrowserSessionOptions extends CdpConnectOptions {
  /**
   * Hosts `navigate` may load. `*.example.com` matches subdomains and the
   * apex. Empty or absent means any host; the platform's egress allowlist is
   * the real boundary either way.
   */
  allowedDomains?: string[];
  /** Upper bound on waiting for a page to settle after an action. */
  settleMs?: number;
  /** Screenshots are downscaled to at most this many pixels wide. Default 1280. */
  screenshotMaxWidth?: number;
}

interface Tab {
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  /**
   * Screenshot pixels per CSS pixel of this tab's latest screenshot; unset
   * until one is taken and again after a navigation, so `clickAt` only
   * lands on coordinates read off the page as it is.
   */
  screenshotScale?: number;
}

type ScriptResult = {
  error?: BrowserErrorCode | "__missing__";
  message?: string;
} & Record<string, unknown>;

export function hostAllowed(url: string, allowedDomains?: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return allowedDomains.some((pattern) =>
    pattern.startsWith("*.")
      ? host === pattern.slice(2) || host.endsWith(pattern.slice(1))
      : host === pattern,
  );
}

/**
 * A connection to one browser over raw CDP, with the `browser.v1` page
 * script installed in every tab it attaches to. Works against any CDP
 * endpoint: the platform's sidecar or edge, a local Chrome, or a hosted
 * provider's `cdp_ws_url`.
 */
export class BrowserSession {
  private readonly tabs = new Map<string, Tab>();
  private activeTab: string | null = null;
  private readonly eventListeners = new Set<(event: BrowserEvent) => void>();

  private constructor(
    private readonly cdp: CdpConnection,
    private readonly options: BrowserSessionOptions,
  ) {
    cdp.on((event) => this.onCdpEvent(event));
  }

  static async connect(
    endpoint: string,
    options: BrowserSessionOptions = {},
  ): Promise<BrowserSession> {
    const cdp = await CdpConnection.connect(endpoint, options);
    const session = new BrowserSession(cdp, options);
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    await cdp
      .send("Browser.setDownloadBehavior", {
        behavior: "default",
        eventsEnabled: true,
      })
      .catch(() => undefined);
    const { targetInfos } = await cdp.send<{
      targetInfos: {
        targetId: string;
        type: string;
        url: string;
        title: string;
      }[];
    }>("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page");
    if (pages.length === 0) {
      await session.openTab("about:blank");
    } else {
      for (const page of pages) await session.attach(page.targetId);
      session.activeTab = pages[0]!.targetId;
    }
    return session;
  }

  get scriptVersion(): string {
    return PAGE_SCRIPT_VERSION;
  }

  onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async tabList(): Promise<TabInfo[]> {
    return [...this.tabs.values()].map((t) => ({
      tab_id: t.targetId,
      url: t.url,
      title: t.title,
      active: t.targetId === this.activeTab,
    }));
  }

  async observe(
    opts: {
      tab_id?: string;
      cursor?: number;
      limit?: number;
      screenshot?: boolean;
    } = {},
  ): Promise<Observation> {
    const tab = this.tab(opts.tab_id);
    const result = await this.call(tab, "observe", [
      { cursor: opts.cursor ?? 0, limit: opts.limit },
    ]);
    const observation = {
      ...(result as object),
      tab_id: tab.targetId,
    } as Observation;
    tab.url = observation.url;
    tab.title = observation.title;
    if (opts.screenshot) {
      const shot = await this.screenshot({ tab_id: tab.targetId });
      observation.screenshot = shot.data;
      observation.screenshot_size = {
        width: shot.width,
        height: shot.height,
      };
    }
    return observation;
  }

  async act(opts: {
    element: string;
    action: ElementAction;
    text?: string;
    files?: string[];
    tab_id?: string;
  }): Promise<{ ok: true; value?: string }> {
    const tab = this.tab(opts.tab_id);
    switch (opts.action) {
      case "click": {
        const at = (await this.call(tab, "locate", [opts.element])) as {
          x: number;
          y: number;
        };
        await this.click(tab, at.x, at.y);
        await this.settle(tab);
        return { ok: true };
      }
      case "type": {
        if (typeof opts.text !== "string") {
          throw new BrowserError("invalid_argument", "type needs text");
        }
        await this.call(tab, "prepareType", [opts.element]);
        await this.cdp.send(
          "Input.insertText",
          { text: opts.text },
          tab.sessionId,
        );
        const done = (await this.call(tab, "commitType", [opts.element])) as {
          value?: string;
        };
        await this.settle(tab);
        return { ok: true, value: done.value };
      }
      case "select": {
        if (typeof opts.text !== "string") {
          throw new BrowserError(
            "invalid_argument",
            "select needs text: the option label",
          );
        }
        const done = (await this.call(tab, "select", [
          opts.element,
          opts.text,
        ])) as {
          value?: string;
        };
        await this.settle(tab);
        return { ok: true, value: done.value };
      }
      case "upload": {
        if (!opts.files || opts.files.length === 0) {
          throw new BrowserError("invalid_argument", "upload needs files");
        }
        const { result } = await this.cdp.send<{
          result: { objectId?: string };
        }>(
          "Runtime.evaluate",
          {
            expression: `window.__introspection.browser.v1.node(${JSON.stringify(opts.element)})`,
          },
          tab.sessionId,
        );
        if (!result.objectId) {
          throw new BrowserError(
            "stale",
            `element ${opts.element} is no longer on the page; observe again`,
          );
        }
        await this.cdp.send(
          "DOM.setFileInputFiles",
          { files: opts.files, objectId: result.objectId },
          tab.sessionId,
        );
        await this.settle(tab);
        return { ok: true };
      }
      default:
        throw new BrowserError(
          "invalid_argument",
          `unknown action ${String(opts.action)}`,
        );
    }
  }

  /**
   * Presses keys on whatever has focus, in order: `"Enter"`, `"ArrowLeft"`,
   * `"Space"`, `"a"`, `"Shift+Tab"`, `"Control+a"`. For keyboard-driven
   * pages (menus, editors, games); text belongs in `act` `type`.
   */
  async press(opts: {
    keys: string[];
    tab_id?: string;
  }): Promise<{ ok: true; pressed: number }> {
    if (opts.keys.length === 0 || opts.keys.length > MAX_PRESS_KEYS) {
      throw new BrowserError(
        "invalid_argument",
        `press takes 1 to ${MAX_PRESS_KEYS} keys`,
      );
    }
    const chords = opts.keys.map(parseChord);
    const tab = this.tab(opts.tab_id);
    for (const { key, modifiers } of chords) {
      const event = {
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
        modifiers,
      };
      await this.cdp.send(
        "Input.dispatchKeyEvent",
        key.text !== undefined
          ? {
              ...event,
              type: "keyDown",
              text: key.text,
              unmodifiedText: key.text,
            }
          : { ...event, type: "rawKeyDown" },
        tab.sessionId,
      );
      await this.cdp.send(
        "Input.dispatchKeyEvent",
        { ...event, type: "keyUp" },
        tab.sessionId,
      );
    }
    await this.settle(tab);
    return { ok: true, pressed: chords.length };
  }

  /**
   * Clicks a point of the tab's latest screenshot, in that screenshot's
   * pixels. The vision fallback for what the element table cannot name; it
   * skips the handle checks `act` makes, so it needs a screenshot taken since
   * the last navigation.
   */
  async clickAt(opts: {
    x: number;
    y: number;
    tab_id?: string;
  }): Promise<{ ok: true }> {
    const tab = this.tab(opts.tab_id);
    if (!tab.screenshotScale) {
      throw new BrowserError(
        "invalid_argument",
        "clickAt needs a screenshot of the current page first",
      );
    }
    const x = opts.x / tab.screenshotScale;
    const y = opts.y / tab.screenshotScale;
    const view = (await this.evaluate(
      tab,
      "({ w: innerWidth, h: innerHeight })",
    )) as { w: number; h: number };
    if (!(x >= 0 && y >= 0 && x < view.w && y < view.h)) {
      throw new BrowserError(
        "invalid_argument",
        `(${opts.x}, ${opts.y}) is outside the screenshot`,
      );
    }
    await this.click(tab, x, y);
    await this.settle(tab);
    return { ok: true };
  }

  async navigate(opts: { url: string; tab_id?: string }): Promise<TabInfo> {
    if (!hostAllowed(opts.url, this.options.allowedDomains)) {
      throw new BrowserError(
        "blocked_navigation",
        `${opts.url} is outside the allowed domains`,
      );
    }
    if (opts.tab_id === "new") {
      const tab = await this.openTab(opts.url);
      return {
        tab_id: tab.targetId,
        url: tab.url,
        title: tab.title,
        active: true,
      };
    }
    const tab = this.tab(opts.tab_id);
    const loaded = this.cdp
      .waitFor(
        (e) =>
          e.method === "Page.loadEventFired" && e.sessionId === tab.sessionId,
        20_000,
      )
      .catch(() => undefined);
    const nav = await this.cdp.send<{ errorText?: string }>(
      "Page.navigate",
      { url: opts.url },
      tab.sessionId,
    );
    if (nav.errorText) {
      throw new BrowserError(
        "blocked_navigation",
        `navigation failed: ${nav.errorText}`,
      );
    }
    await loaded;
    this.activeTab = tab.targetId;
    return {
      tab_id: tab.targetId,
      url: opts.url,
      title: tab.title,
      active: true,
    };
  }

  async scroll(opts: {
    direction: "up" | "down";
    tab_id?: string;
  }): Promise<{ moved: boolean; y: number }> {
    const tab = this.tab(opts.tab_id);
    const out = (await this.call(tab, "scroll", [opts.direction])) as {
      moved: boolean;
      y: number;
    };
    await this.settle(tab, 100);
    return out;
  }

  /**
   * The visible viewport as a JPEG in CSS pixels, downscaled to at most
   * `screenshotMaxWidth` wide, whatever the device pixel ratio.
   */
  async screenshot(opts: { tab_id?: string } = {}): Promise<Screenshot> {
    const tab = this.tab(opts.tab_id);
    const view = (await this.evaluate(
      tab,
      "({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight, dpr: devicePixelRatio })",
    )) as { x: number; y: number; w: number; h: number; dpr: number };
    const scale = Math.min(
      1,
      (this.options.screenshotMaxWidth ?? 1280) / view.w,
    );
    // The clip is in page coordinates, and its scale multiplies the device
    // pixel ratio, so dividing by it yields CSS-sized output.
    const { data } = await this.cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 60,
        clip: {
          x: view.x,
          y: view.y,
          width: view.w,
          height: view.h,
          scale: scale / (view.dpr || 1),
        },
      },
      tab.sessionId,
    );
    tab.screenshotScale = scale;
    return {
      mime_type: "image/jpeg",
      data,
      width: Math.round(view.w * scale),
      height: Math.round(view.h * scale),
      scale,
    };
  }

  /**
   * Hands a goal to a driver ladder: observe, ask the current driver for one
   * step, act, repeat. Starts on the cheapest driver and escalates on
   * `blocked`, repeated invalid actions or a spent step budget; a `done` is
   * checked against `success` when one is given.
   */
  run(options: RunOptions): Promise<RunResult> {
    return runDriverLadder(this, options);
  }

  /** Detaches from the browser; the browser itself keeps running. */
  close(): void {
    this.cdp.close();
  }

  // --- internals ---

  private tab(tabId?: string): Tab {
    const id = tabId ?? this.activeTab;
    const tab = id ? this.tabs.get(id) : undefined;
    if (!tab) {
      throw new BrowserError("unknown_tab", `no tab ${tabId ?? "(active)"}`);
    }
    return tab;
  }

  private async openTab(url: string): Promise<Tab> {
    const { targetId } = await this.cdp.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    const tab = await this.attach(targetId);
    this.activeTab = targetId;
    if (url !== "about:blank") await this.navigate({ url, tab_id: targetId });
    return tab;
  }

  private async attach(targetId: string): Promise<Tab> {
    const existing = this.tabs.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    const tab: Tab = { targetId, sessionId, url: "", title: "" };
    this.tabs.set(targetId, tab);
    await this.cdp.send("Page.enable", {}, sessionId);
    await this.cdp.send("Runtime.enable", {}, sessionId);
    await this.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: PAGE_SCRIPT },
      sessionId,
    );
    await this.cdp.send(
      "Runtime.evaluate",
      { expression: PAGE_SCRIPT },
      sessionId,
    );
    return tab;
  }

  private async call(tab: Tab, fn: string, args: unknown[]): Promise<unknown> {
    const argList = args.map((a) => JSON.stringify(a ?? null)).join(",");
    const expression =
      `(() => { const b = window.__introspection && window.__introspection.browser;` +
      ` if (!b || !b.v1) return { error: "__missing__" };` +
      ` return b.v1.${fn}(${argList}); })()`;
    let result = await this.evaluate(tab, expression);
    if ((result as ScriptResult)?.error === "__missing__") {
      await this.cdp.send(
        "Runtime.evaluate",
        { expression: PAGE_SCRIPT },
        tab.sessionId,
      );
      result = await this.evaluate(tab, expression);
    }
    const r = result as ScriptResult;
    if (
      r &&
      typeof r === "object" &&
      typeof r.error === "string" &&
      r.error !== "__missing__"
    ) {
      throw new BrowserError(r.error, r.message ?? r.error);
    }
    return result;
  }

  private async evaluate(tab: Tab, expression: string): Promise<unknown> {
    const out = await this.cdp.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      tab.sessionId,
    );
    if (out.exceptionDetails) {
      throw new Error(
        `page script failed: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`,
      );
    }
    return out.result.value;
  }

  private async click(tab: Tab, x: number, y: number): Promise<void> {
    const base = { x, y, button: "left", clickCount: 1 };
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x, y },
      tab.sessionId,
    );
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { ...base, type: "mousePressed" },
      tab.sessionId,
    );
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { ...base, type: "mouseReleased" },
      tab.sessionId,
    );
  }

  /**
   * Waits briefly for the page to react: a navigation that starts gets until
   * its load event (bounded by `settleMs`), anything else a short quiet period.
   */
  private async settle(tab: Tab, quietMs = 150): Promise<void> {
    const limit = this.options.settleMs ?? 5_000;
    const started = await this.cdp
      .waitFor(
        (e) =>
          e.sessionId === tab.sessionId &&
          (e.method === "Page.frameStartedLoading" ||
            e.method === "Page.frameNavigated"),
        quietMs,
      )
      .then(() => true)
      .catch(() => false);
    if (started) {
      await this.cdp
        .waitFor(
          (e) =>
            e.sessionId === tab.sessionId && e.method === "Page.loadEventFired",
          limit,
        )
        .catch(() => undefined);
    }
  }

  private onCdpEvent(event: CdpEvent): void {
    const tab = [...this.tabs.values()].find(
      (t) => t.sessionId === event.sessionId,
    );
    const p = event.params as Record<string, never>;
    let out: BrowserEvent | null = null;
    switch (event.method) {
      case "Target.targetCreated": {
        const info = p.targetInfo as unknown as {
          targetId: string;
          type: string;
          url: string;
        };
        if (info.type === "page" && !this.tabs.has(info.targetId)) {
          void this.attach(info.targetId).catch(() => undefined);
          out = { type: "tab.created", tab_id: info.targetId, url: info.url };
        }
        break;
      }
      case "Target.targetDestroyed": {
        const targetId = p.targetId as unknown as string;
        if (this.tabs.delete(targetId)) {
          if (this.activeTab === targetId)
            this.activeTab = this.tabs.keys().next().value ?? null;
          out = { type: "tab.closed", tab_id: targetId };
        }
        break;
      }
      case "Page.frameNavigated": {
        const frame = p.frame as unknown as { parentId?: string; url: string };
        if (tab && !frame.parentId) {
          tab.url = frame.url;
          tab.screenshotScale = undefined;
          out = {
            type: "page.navigated",
            tab_id: tab.targetId,
            url: frame.url,
          };
        }
        break;
      }
      case "Page.javascriptDialogOpening":
        if (tab) {
          out = {
            type: "page.dialog",
            tab_id: tab.targetId,
            kind: p.type as unknown as string,
            message: p.message as unknown as string,
          };
        }
        break;
      case "Browser.downloadWillBegin":
        out = {
          type: "download.started",
          url: p.url as unknown as string,
          filename: p.suggestedFilename as unknown as string,
        };
        break;
      case "Inspector.targetCrashed":
        if (tab) out = { type: "page.crashed", tab_id: tab.targetId };
        break;
    }
    if (out) for (const listener of this.eventListeners) listener(out);
  }
}
