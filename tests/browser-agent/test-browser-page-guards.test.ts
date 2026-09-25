// The page-script behaviours ported from jev-ultrafast, on real Chromium: the
// semantic guard, settling for autocomplete, viewport-scoped observation,
// accessible names, option values, and the run loop's no-effect stop.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserSession,
  type Decision,
  type Driver,
  type Observation,
} from "@introspection-sdk/browser-agent";
import { findChrome, launchChrome, type LaunchedChrome } from "./chrome";

const chrome = findChrome();

const PAGE = `<!doctype html><html><head><title>Guards</title>
<style>body{margin:0;font:16px sans-serif} .far{margin-top:2000px}</style></head><body>
<ul id="rows">
  <li>Invoice 1 <button onclick="log('deleted 1')">Delete</button></li>
  <li>Invoice 2 <button onclick="log('deleted 2')">Delete</button></li>
</ul>
<button onclick="reorder()">Sort</button>
<button onclick="">Does nothing</button>
<span id="first">Shipping</span><span id="second">speed</span>
<select id="speed" aria-labelledby="first second">
  <option value="std">Standard</option>
  <option value="exp" disabled>Express</option>
  <option value="n1">Next day</option>
  <option value="n2">Next day</option>
</select>
<button><span aria-hidden="true">★</span> Save</button>
<div role="grid"><div role="row">
  <div role="gridcell">12</div>
  <div role="gridcell"><button>13</button></div>
</div></div>
<input id="q" role="combobox" aria-label="Destination" aria-controls="suggestions" aria-autocomplete="list">
<ul id="suggestions" role="listbox"></ul>
<p id="log">nothing yet</p>
<p class="far">Below the fold</p>
<button>Far away</button>
<script>
  function log(m) { document.getElementById('log').textContent = m; }
  function reorder() {
    const rows = document.getElementById('rows');
    const [a, b] = rows.children;
    // Swap the labels but keep the nodes: each button now deletes the other invoice.
    a.firstChild.textContent = 'Invoice 2 ';
    b.firstChild.textContent = 'Invoice 1 ';
  }
  document.getElementById('q').addEventListener('input', (e) => {
    const value = e.target.value;
    setTimeout(() => {
      document.getElementById('suggestions').innerHTML =
        '<li role="option">' + value + ' (city)</li>';
    }, 80);
  });
</script>
</body></html>`;

describe.skipIf(!chrome)("browser.v1 guards on Chromium", () => {
  let browser: LaunchedChrome;
  let server: Server;
  let url: string;
  let session: BrowserSession;

  const row = (o: Observation, name: string, nth = 0) => {
    const rows = o.elements.filter((e) => e.name === name);
    if (!rows[nth]) throw new Error(`no element ${name}`);
    return rows[nth]!;
  };

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

  it("refuses a handle whose element changed meaning since it was observed", async () => {
    const before = await session.observe();
    const deleteFirst = row(before, "Delete", 0).element;
    await session.act({
      element: row(before, "Sort").element,
      action: "click",
    });
    await expect(
      session.act({ element: deleteFirst, action: "click" }),
    ).rejects.toMatchObject({ code: "stale" });
    expect((await session.observe()).text).toContain("nothing yet");
  });

  it("keeps a handle usable after the agent's own typing changed its value", async () => {
    const o = await session.observe();
    const q = row(o, "Destination").element;
    await session.act({ element: q, action: "type", text: "Lis" });
    await session.act({ element: q, action: "type", text: "Lisbon" });
    expect(row(await session.observe(), "Destination").value).toBe("Lisbon");
  });

  it("waits for an autocomplete's suggestions before the next observation", async () => {
    const o = await session.observe();
    await session.act({
      element: row(o, "Destination").element,
      action: "type",
      text: "Lisbon",
    });
    const after = await session.observe();
    expect(after.elements.some((e) => e.name === "Lisbon (city)")).toBe(true);
  });

  it("follows labelledby, skips aria-hidden text, and reaches a cell's button", async () => {
    const o = await session.observe();
    expect(o.elements.some((e) => e.name === "Shipping speed")).toBe(true);
    expect(o.elements.some((e) => e.name === "Save")).toBe(true);
    expect(
      o.elements.some((e) => e.role === "gridcell" && e.name === "12"),
    ).toBe(true);
    expect(
      o.elements.some((e) => e.role === "gridcell" && e.name === "13"),
    ).toBe(false);
    expect(o.elements.some((e) => e.role === "button" && e.name === "13")).toBe(
      true,
    );
  });

  it("lists only enabled options and selects by value between equal labels", async () => {
    const o = await session.observe();
    const speed = row(o, "Shipping speed");
    expect(speed.options).toEqual(["Standard", "Next day", "Next day"]);
    expect(speed.option_values).toEqual(["std", "n1", "n2"]);
    await session.act({
      element: speed.element,
      action: "select",
      value: "n2",
    });
    expect(row(await session.observe(), "Shipping speed").value).toBe(
      "Next day",
    );
    await expect(
      session.act({ element: speed.element, action: "select", value: "exp" }),
    ).rejects.toMatchObject({ code: "no_option" });
  });

  it("scopes to the viewport: only visible controls and the text on screen", async () => {
    const page = await session.observe();
    const view = await session.observe({ scope: "viewport" });
    expect(page.elements.some((e) => e.name === "Far away")).toBe(true);
    expect(view.elements.some((e) => e.name === "Far away")).toBe(false);
    expect(page.text).toContain("Below the fold");
    expect(view.text).not.toContain("Below the fold");
    expect(view.text.length).toBeLessThan(page.text.length);
  });

  it("fingerprints the page: unchanged until something visible changes", async () => {
    const a = await session.observe({ scope: "viewport" });
    const b = await session.observe({ scope: "viewport" });
    expect(a.fingerprint).toBe(b.fingerprint);
    await session.act({ element: row(b, "Delete").element, action: "click" });
    const c = await session.observe({ scope: "viewport" });
    expect(c.fingerprint).not.toBe(b.fingerprint);
  });

  it("stops a run after three actions in a row change nothing", async () => {
    const decisions: Decision[] = [];
    const stubborn: Driver = {
      name: "stubborn",
      observation: "viewport",
      async decide(input) {
        const d: Decision = {
          op: "click",
          element: input.observation.elements.find(
            (e) => e.name === "Does nothing",
          )!.element,
        };
        decisions.push(d);
        return d;
      },
    };
    const result = await session.run({ goal: "g", drivers: [stubborn] });
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/changed nothing/);
    expect(decisions).toHaveLength(3);
    expect(result.steps.map((s) => s.page_changed)).toEqual([
      false,
      false,
      false,
    ]);
  });
});
