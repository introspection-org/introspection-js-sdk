/**
 * The `browser.v1` page script: everything that has to look at the DOM runs
 * here, inside the page, so every client (this SDK, the CLI, the runtime
 * tool) gets the same element table and the same guards over plain CDP.
 *
 * Installed with `Page.addScriptToEvaluateOnNewDocument` and called through
 * `Runtime.evaluate`. Element handles live in a table on `window`, so a new
 * document starts empty and every handle from the previous one reads as
 * stale. Handles embed a per-document token so a reused number from a newer
 * document can never resolve an older handle.
 */
export const PAGE_SCRIPT_VERSION = "browser.v1";

export const PAGE_SCRIPT = String.raw`(() => {
  const ns = (window.__introspection = window.__introspection || {});
  ns.browser = ns.browser || {};
  if (ns.browser.v1) return;

  const doc = Math.random().toString(36).slice(2, 8);
  const ids = new WeakMap();
  const nodes = new Map();
  let next = 1;
  const handleOf = (e) => {
    let h = ids.get(e);
    if (!h) {
      h = "el_" + doc + "_" + next++;
      ids.set(e, h);
    }
    nodes.set(h, e);
    return h;
  };

  const ROLES = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
    "option", "combobox", "textbox", "searchbox", "spinbutton", "slider"];
  const SELECTOR = "a[href],button,input:not([type=hidden]),textarea,select,summary," +
    "[contenteditable=true],[contenteditable=''],[tabindex]:not([tabindex='-1'])," +
    ROLES.map((r) => "[role=" + r + "]").join(",");
  const clean = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n || 120);

  const rendered = (e) => {
    if (e.closest("[aria-hidden=true],[inert]")) return false;
    if (e.checkVisibility && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = e.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const inViewport = (e) => {
    const r = e.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const role = (e) => {
    const explicit = e.getAttribute("role");
    if (explicit && ROLES.includes(explicit)) return explicit;
    switch (e.tagName) {
      case "A": return "link";
      case "BUTTON": case "SUMMARY": return "button";
      case "SELECT": return "select";
      case "TEXTAREA": return "textbox";
      case "INPUT": return ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button",
        reset: "button", image: "button", search: "searchbox", password: "password", file: "file",
        range: "slider", number: "spinbutton" })[e.type] || "textbox";
    }
    return e.isContentEditable ? "textbox" : "generic";
  };
  const name = (e) => clean(
    e.getAttribute("aria-label") ||
    (e.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map((i) => (document.getElementById(i) || {}).innerText || "").join(" ") ||
    [...(e.labels || [])].map((l) => l.innerText).join(" ") ||
    (e.tagName === "INPUT" || e.tagName === "SELECT" ? "" : e.innerText) ||
    (["submit", "button", "reset"].includes(e.type) ? e.value : "") ||
    e.getAttribute("title") || e.getAttribute("placeholder") || e.getAttribute("alt") || "");

  const describe = (e) => {
    const r = role(e);
    const row = { element: handleOf(e), role: r, name: name(e) };
    if (r === "password") {
      row.value = e.value ? "(set)" : "";
      row.actions = ["type"];
    } else if (r === "file") {
      row.actions = ["upload"];
    } else if (r === "select") {
      row.value = clean((e.selectedOptions && e.selectedOptions[0] || {}).text || "");
      row.options = [...e.options].slice(0, 50).map((o) => clean(o.text));
      row.actions = ["select"];
    } else if (["textbox", "searchbox", "combobox", "spinbutton"].includes(r)) {
      row.value = clean(e.value !== undefined ? e.value : e.innerText, 200);
      row.actions = ["type", "click"];
    } else {
      if ("checked" in e && ["checkbox", "radio", "switch"].includes(r)) row.checked = e.checked;
      const expanded = e.getAttribute("aria-expanded");
      if (expanded !== null) row.expanded = expanded === "true";
      row.actions = ["click"];
    }
    if (e.disabled || e.getAttribute("aria-disabled") === "true") row.disabled = true;
    if (!inViewport(e)) row.offscreen = true;
    return row;
  };

  const lookup = (handle) => {
    const e = nodes.get(handle);
    if (!e || !e.isConnected) return { error: "stale", message: "element " + handle + " is no longer on the page; observe again" };
    return { e };
  };

  const v1 = {
    version: "browser.v1",

    observe(opts) {
      const o = opts || {};
      const limit = Math.max(1, Math.min(o.limit || 150, 500));
      const cursor = Math.max(0, o.cursor || 0);
      for (const [h, e] of nodes) if (!e.isConnected) nodes.delete(h);
      const all = [...document.querySelectorAll(SELECTOR)].filter(rendered);
      const visible = all.filter(inViewport);
      const offscreen = all.filter((e) => !inViewport(e));
      const ordered = visible.concat(offscreen);
      const page = ordered.slice(cursor, cursor + limit).map(describe);
      const text = (document.body ? document.body.innerText : "").replace(/\n{2,}/g, "\n").slice(0, 4000);
      return {
        version: "browser.v1",
        url: location.href,
        title: document.title,
        text,
        scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
        elements: page,
        next_cursor: cursor + limit < ordered.length ? cursor + limit : null,
      };
    },

    // Where to deliver a trusted click, after proving the element is still
    // there, enabled, and the topmost thing at that point.
    locate(handle) {
      const found = lookup(handle);
      if (found.error) return found;
      const e = found.e;
      if (e.disabled || e.getAttribute("aria-disabled") === "true") return { error: "disabled", message: handle + " is disabled" };
      e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { error: "hidden", message: handle + " has no size" };
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const label = hit && hit.closest("label");
      const ours = hit && (hit === e || e.contains(hit) || (label && label.control === e));
      if (!ours) return { error: "covered", message: handle + " is covered by " + (hit ? describe(hit).name || hit.tagName.toLowerCase() : "nothing") };
      return { x, y };
    },

    prepareType(handle) {
      const found = lookup(handle);
      if (found.error) return found;
      const e = found.e;
      e.scrollIntoView({ block: "center", behavior: "instant" });
      e.focus();
      if (typeof e.select === "function") e.select();
      else if (e.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(e);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (document.activeElement !== e) return { error: "unfocusable", message: handle + " did not take focus" };
      return { ok: true };
    },

    commitType(handle) {
      const found = lookup(handle);
      if (found.error) return found;
      found.e.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: clean(found.e.value !== undefined ? found.e.value : found.e.innerText, 200) };
    },

    select(handle, label) {
      const found = lookup(handle);
      if (found.error) return found;
      const e = found.e;
      if (e.tagName !== "SELECT") return { error: "unsupported", message: handle + " is not a select" };
      const option = [...e.options].find((o) => clean(o.text) === label);
      if (!option) return { error: "no_option", message: JSON.stringify(label) + " is not an option of " + handle };
      e.value = option.value;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: clean(option.text) };
    },

    // Used for file uploads: the client resolves this to a node and calls
    // DOM.setFileInputFiles on it.
    node(handle) {
      const found = lookup(handle);
      return found.error ? null : found.e;
    },

    scroll(direction) {
      const before = scrollY;
      scrollBy({ top: (direction === "up" ? -1 : 1) * innerHeight * 0.8, behavior: "instant" });
      return { moved: scrollY !== before, y: Math.round(scrollY) };
    },
  };

  ns.browser.v1 = v1;
})();
`;
