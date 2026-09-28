// `press`, screenshot-coordinate clicks, and the run loop driving both, on real
// Chromium. The fixture is keyboard-first: a key log, a form submitted with
// Enter, and a target that only a coordinate click can reach (it has no role).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  BrowserSession,
  JevDriver,
  createBrowserTool,
  parseChord,
  type Decision,
  type Driver,
} from "@introspection-sdk/browser-agent";
import { findChrome, launchChrome, type LaunchedChrome } from "./chrome";
import { fakeJev } from "./jev-fake";

const chrome = findChrome();

const PAGE = `<!doctype html><html><head><title>Keys</title>
<style>body{margin:0;font:16px sans-serif} #target{position:absolute;left:400px;top:300px;width:40px;height:40px;background:#c00}</style>
</head><body>
<form onsubmit="event.preventDefault(); document.getElementById('status').textContent='submitted ' + document.getElementById('q').value">
  <input id="q" aria-label="Query" value="">
</form>
<p id="status">idle</p>
<p id="log"></p>
<div id="target" onclick="document.getElementById('status').textContent='hit ' + event.clientX + ',' + event.clientY"></div>
<script>
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'q' && e.key !== 'Enter') return;
    const mods = (e.ctrlKey ? 'C' : '') + (e.shiftKey ? 'S' : '');
    document.getElementById('log').textContent += (mods ? mods + '-' : '') + e.key + ';';
  });
</script>
</body></html>`;

describe("parseChord", () => {
  it("parses named keys, characters and modifier chords", () => {
    expect(parseChord("Enter")).toMatchObject({
      key: { key: "Enter", keyCode: 13, text: "\r" },
      modifiers: 0,
    });
    expect(parseChord("Space").key.text).toBe(" ");
    expect(parseChord("Shift+a")).toMatchObject({
      key: { key: "A", code: "KeyA", text: "A" },
      modifiers: 8,
    });
    // A shortcut inserts no text.
    expect(parseChord("Control+a")).toMatchObject({
      key: { key: "a", text: undefined },
      modifiers: 2,
    });
  });

  it("refuses unknown keys and modifiers", () => {
    expect(() => parseChord("hello")).toThrow(/unknown key/);
    expect(() => parseChord("Hyper+a")).toThrow(/unknown modifier/);
    expect(() => parseChord("")).toThrow(/unknown key/);
  });
});

describe.skipIf(!chrome)("press and clickAt against Chromium", () => {
  let browser: LaunchedChrome;
  let server: Server;
  let url: string;
  let session: BrowserSession;

  const text = async (id: string) =>
    (await session.observe()).text.includes(id);

  beforeAll(async () => {
    browser = await launchChrome(chrome!);
    server = createServer((_, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`;
    session = await BrowserSession.connect(browser.endpoint);
  });

  afterAll(async () => {
    session?.close();
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  beforeEach(async () => {
    await session.navigate({ url });
  });

  it("presses keys in order, with modifiers, on the focused page", async () => {
    await session.press({ keys: ["ArrowLeft", "Space", "x", "Shift+Tab"] });
    expect(await text("ArrowLeft; ;x;S-Tab;")).toBe(true);
    await expect(session.press({ keys: [] })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(session.press({ keys: ["Nope"] })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("submits a typed field with Enter", async () => {
    const box = (await session.observe()).elements.find(
      (e) => e.name === "Query",
    )!;
    await session.act({ element: box.element, action: "type", text: "tetris" });
    await session.press({ keys: ["Enter"] });
    expect(await text("submitted tetris")).toBe(true);
  });

  it("takes CSS-pixel screenshots and clicks a point of one", async () => {
    await expect(session.clickAt({ x: 10, y: 10 })).rejects.toThrow(
      /screenshot/,
    );
    // The viewport, not the window: headful-mode Chrome takes its UI out of it.
    const viewport = (await session.observe()).scroll.viewport;
    const shot = await session.screenshot();
    expect(shot).toMatchObject({ width: 800, height: viewport, scale: 1 });
    await session.clickAt({ x: 420, y: 320 });
    expect(await text("hit 420,320")).toBe(true);
    await expect(session.clickAt({ x: 900, y: 10 })).rejects.toThrow(/outside/);
    // A navigation retires the screenshot the coordinates came from.
    await session.navigate({ url });
    await expect(session.clickAt({ x: 420, y: 320 })).rejects.toThrow(
      /screenshot/,
    );
  });

  it("scales coordinates with a downscaled screenshot", async () => {
    const small = await BrowserSession.connect(browser.endpoint, {
      screenshotMaxWidth: 400,
    });
    try {
      const o = await small.observe({ screenshot: true });
      expect(o.screenshot_size).toEqual({
        width: 400,
        height: Math.round(o.scroll.viewport / 2),
      });
      await small.clickAt({ x: 210, y: 160 });
      expect((await small.observe()).text).toContain("hit 420,320");
    } finally {
      small.close();
    }
  });

  it("exposes press and coordinate clicks through the tool", async () => {
    const tool = createBrowserTool({ session });
    expect(tool.commands).toContain("press");
    expect(await tool.call({ command: "press", keys: ["Escape"] })).toEqual({
      ok: true,
      pressed: 1,
    });
    await tool.call({ command: "screenshot" });
    await tool.call({ command: "act", action: "click", x: 405, y: 305 });
    expect(await text("hit 405,305")).toBe(true);
    await expect(
      tool.call({ command: "act", action: "click" }),
    ).rejects.toThrow(/x and y/);
    await expect(tool.call({ command: "press" } as never)).rejects.toThrow(
      /keys/,
    );
  });

  it("runs a vision driver's presses and coordinate clicks", async () => {
    const script: Decision[] = [
      { op: "press", keys: ["ArrowDown", "ArrowDown"] },
      { op: "click", x: 410, y: 310 },
      { op: "done", text: "ok" },
    ];
    const seen: (string | undefined)[] = [];
    const vision: Driver = {
      name: "scripted-vision",
      vision: true,
      async decide(input) {
        seen.push(input.observation.screenshot?.slice(0, 4));
        return script[input.step]!;
      },
    };
    const result = await session.run({
      goal: "hit the target",
      drivers: [vision],
      success: (o) => o.text.includes("hit 410,310"),
    });
    expect(result.status).toBe("done");
    expect(result.steps.map((s) => s.error)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(seen.every((s) => s === "/9j/")).toBe(true);
    expect((await session.observe()).text).toContain("ArrowDown;ArrowDown;");
  });
});

describe("JevDriver press operations", () => {
  const observation = {
    version: "browser.v1",
    tab_id: "t",
    url: "https://shop.test/",
    title: "Shop",
    text: "",
    scroll: { y: 0, height: 600, viewport: 600 },
    elements: [],
    next_cursor: null,
  };
  const input = {
    goal: "submit",
    observation,
    table: "",
    history: [],
    step: 0,
  };

  it("offers PRESS_ENTER and PRESS_ESCAPE unless turned off", async () => {
    const off = fakeJev({ operation: "WAIT" });
    await new JevDriver({ fetch: off.fetch, press: false }).decide(input);
    expect(
      Object.keys(off.bodies[0]!.questions.operation.criteria),
    ).not.toContain("PRESS_ENTER");

    const on = fakeJev({ operation: "PRESS_ENTER" });
    const d = await new JevDriver({ fetch: on.fetch }).decide(input);
    expect(Object.keys(on.bodies[0]!.questions.operation.criteria)).toEqual(
      expect.arrayContaining(["PRESS_ENTER", "PRESS_ESCAPE"]),
    );
    expect(d).toMatchObject({ op: "press", keys: ["Enter"] });
  });
});
