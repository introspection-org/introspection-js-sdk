import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserError,
  BrowserSession,
  CdpConnection,
  PAGE_SCRIPT,
  PAGE_SCRIPT_VERSION,
  hostAllowed,
  resolveCdpUrl,
  type BrowserEvent,
  type Observation,
} from "@introspection-sdk/browser-agent";
import {
  findChrome,
  launchChrome,
  serveFixture,
  type FixtureServer,
  type LaunchedChrome,
} from "./chrome";

const chrome = findChrome();

describe("hostAllowed", () => {
  it("allows anything when no domains are configured", () => {
    expect(hostAllowed("https://anything.test/x")).toBe(true);
    expect(hostAllowed("https://anything.test/x", [])).toBe(true);
  });
  it("matches exact hosts and wildcard subdomains, including the apex", () => {
    const allowed = ["app.example.com", "*.shop.test"];
    expect(hostAllowed("https://app.example.com/a", allowed)).toBe(true);
    expect(hostAllowed("https://other.example.com/a", allowed)).toBe(false);
    expect(hostAllowed("https://shop.test/", allowed)).toBe(true);
    expect(hostAllowed("https://eu.shop.test/", allowed)).toBe(true);
    expect(hostAllowed("https://evilshop.test/", allowed)).toBe(false);
  });
  it("rejects a malformed URL", () => {
    expect(hostAllowed("not a url", ["a.test"])).toBe(false);
  });
});

describe("page script", () => {
  it("is versioned and self-installing", () => {
    expect(PAGE_SCRIPT_VERSION).toBe("browser.v1");
    expect(PAGE_SCRIPT).toContain("ns.browser.v1 = v1");
  });
});

describe.skipIf(!chrome)("BrowserSession against Chromium", () => {
  let browser: LaunchedChrome;
  let fixture: FixtureServer;
  let session: BrowserSession;
  const events: BrowserEvent[] = [];

  const find = (o: Observation, name: string) => {
    const row = o.elements.find((e) => e.name.includes(name));
    if (!row) throw new Error(`no element named ${name}`);
    return row;
  };

  beforeAll(async () => {
    browser = await launchChrome(chrome!);
    fixture = await serveFixture();
    session = await BrowserSession.connect(browser.endpoint, {
      allowedDomains: ["127.0.0.1"],
    });
    session.onEvent((e) => events.push(e));
  });

  afterAll(async () => {
    session?.close();
    await browser?.close();
    await fixture?.close();
  });

  beforeEach(async () => {
    await session.navigate({ url: fixture.url });
  });

  it("observes controls with roles, names, values and actions", async () => {
    const o = await session.observe();
    expect(o.version).toBe("browser.v1");
    expect(o.title).toBe("Stays");
    expect(find(o, "Destination")).toMatchObject({
      role: "searchbox",
      value: "",
      actions: ["type", "click"],
    });
    expect(find(o, "Category")).toMatchObject({
      role: "select",
      value: "All",
      options: ["All", "Design", "Nature"],
    });
    expect(find(o, "Free cancellation")).toMatchObject({
      role: "checkbox",
      checked: false,
    });
    expect(find(o, "Disabled action").disabled).toBe(true);
    expect(find(o, "Attachment").actions).toEqual(["upload"]);
    expect(o.elements.every((e) => /^el_[a-z0-9]+_\d+$/.test(e.element))).toBe(
      true,
    );
  });

  it("lists offscreen controls after visible ones, flagged", async () => {
    const o = await session.observe();
    const far = find(o, "Far away");
    expect(far.offscreen).toBe(true);
    expect(o.elements.indexOf(far)).toBe(o.elements.length - 1);
    await session.act({ element: far.element, action: "click" });
    expect((await session.observe()).text).toContain("far clicked");
  });

  it("types, selects, clicks and submits", async () => {
    let o = await session.observe();
    const typed = await session.act({
      element: find(o, "Destination").element,
      action: "type",
      text: "Lisbon",
    });
    expect(typed.value).toBe("Lisbon");
    // Typing replaces, never appends.
    await session.act({
      element: find(o, "Destination").element,
      action: "type",
      text: "Porto",
    });
    await session.act({
      element: find(o, "Category").element,
      action: "select",
      text: "Design",
    });
    await session.act({
      element: find(o, "Free cancellation").element,
      action: "click",
    });
    await session.act({ element: find(o, "Search").element, action: "click" });
    o = await session.observe();
    expect(o.text).toContain("searched Porto / Design / free");
    expect(find(o, "Free cancellation").checked).toBe(true);
  });

  it("uploads a file through an observed file input", async () => {
    const path = join(tmpdir(), "browser-agent-upload.txt");
    writeFileSync(path, "hello");
    const o = await session.observe();
    await session.act({
      element: find(o, "Attachment").element,
      action: "upload",
      files: [path],
    });
    await session.act({ element: find(o, "Search").element, action: "click" });
    expect((await session.observe()).text).toContain(
      "browser-agent-upload.txt",
    );
  });

  it("refuses an element that is covered, disabled, or from another page", async () => {
    let o = await session.observe();
    await expect(
      session.act({
        element: find(o, "Disabled action").element,
        action: "click",
      }),
    ).rejects.toMatchObject({ code: "disabled" });

    await session.act({
      element: find(o, "Show banner").element,
      action: "click",
    });
    o = await session.observe();
    await expect(
      session.act({ element: find(o, "Destination").element, action: "click" }),
    ).rejects.toMatchObject({ code: "covered" });

    const before = find(o, "Search").element;
    await session.navigate({ url: fixture.url });
    await expect(
      session.act({ element: before, action: "click" }),
    ).rejects.toMatchObject({
      code: "stale",
    });
    await expect(
      session.act({ element: "el_forged_1", action: "click" }),
    ).rejects.toBeInstanceOf(BrowserError);
  });

  it("validates act arguments", async () => {
    const o = await session.observe();
    const dest = find(o, "Destination").element;
    await expect(
      session.act({ element: dest, action: "type" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      session.act({ element: dest, action: "select" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      session.act({ element: dest, action: "upload" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      session.act({
        element: find(o, "Category").element,
        action: "select",
        text: "Beach",
      }),
    ).rejects.toMatchObject({ code: "no_option" });
    await expect(
      session.act({
        element: find(o, "Search").element,
        action: "select",
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      session.act({ element: dest, action: "jump" as never }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("follows links, reports navigation, and invalidates handles", async () => {
    events.length = 0;
    const o = await session.observe();
    await session.act({
      element: find(o, "Second page").element,
      action: "click",
    });
    const second = await session.observe();
    expect(second.title).toBe("Second");
    expect(second.elements.map((e) => e.name)).toEqual(["Only here"]);
    expect(
      events.some(
        (e) => e.type === "page.navigated" && e.url.endsWith("/second"),
      ),
    ).toBe(true);
  });

  it("blocks navigation outside the allowed domains", async () => {
    await expect(
      session.navigate({ url: "https://example.com/" }),
    ).rejects.toMatchObject({
      code: "blocked_navigation",
    });
  });

  it("pages long element tables with a cursor", async () => {
    const first = await session.observe({ limit: 3 });
    expect(first.elements).toHaveLength(3);
    expect(first.next_cursor).toBe(3);
    const rest = await session.observe({
      cursor: first.next_cursor!,
      limit: 100,
    });
    expect(rest.next_cursor).toBeNull();
    expect(rest.elements[0]!.element).not.toBe(first.elements[0]!.element);
  });

  it("scrolls, and returns screenshots on demand", async () => {
    const down = await session.scroll({ direction: "down" });
    expect(down.moved).toBe(true);
    const up = await session.scroll({ direction: "up" });
    expect(up.y).toBeLessThan(down.y);
    const o = await session.observe({ screenshot: true });
    expect(Buffer.from(o.screenshot!, "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
    const shot = await session.screenshot();
    expect(shot.mime_type).toBe("image/jpeg");
  });

  it("opens, lists and targets tabs", async () => {
    events.length = 0;
    const opened = await session.navigate({
      url: `${fixture.url}/second`,
      tab_id: "new",
    });
    const tabs = await session.tabList();
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    expect(tabs.find((t) => t.tab_id === opened.tab_id)?.active).toBe(true);
    const o = await session.observe({ tab_id: opened.tab_id });
    expect(o.title).toBe("Second");
    await expect(session.observe({ tab_id: "nope" })).rejects.toMatchObject({
      code: "unknown_tab",
    });
  });

  it("reports failed navigations", async () => {
    await expect(
      session.navigate({ url: "http://127.0.0.1:1/" }),
    ).rejects.toMatchObject({
      code: "blocked_navigation",
    });
  });
});

describe.skipIf(!chrome)("CdpConnection", () => {
  let browser: LaunchedChrome;
  beforeAll(async () => {
    browser = await launchChrome(chrome!);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("resolves the browser WebSocket from an HTTP endpoint and passes a ws URL through", async () => {
    const ws = await resolveCdpUrl(browser.endpoint);
    expect(ws).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    expect(await resolveCdpUrl(ws)).toBe(ws);
  });

  it("surfaces protocol errors and fails pending calls on close", async () => {
    const cdp = await CdpConnection.connect(browser.endpoint);
    await expect(cdp.send("No.suchMethod")).rejects.toThrow(/No.suchMethod/);
    await expect(cdp.waitFor(() => false, 20)).rejects.toThrow(/timed out/);
    cdp.close();
    await new Promise((r) => setTimeout(r, 50));
    await expect(cdp.send("Browser.getVersion")).rejects.toThrow(/closed/);
  });

  it("fails discovery on a bad endpoint", async () => {
    await expect(resolveCdpUrl("http://127.0.0.1:1")).rejects.toThrow();
  });
});
