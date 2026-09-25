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
    "menuitemradio", "menuitemcheckbox", "option", "gridcell", "combobox", "textbox",
    "searchbox", "spinbutton", "slider"];
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
  // The accessible name as a screen reader would read it: labelledby followed
  // recursively (cycles cut), aria-hidden descendants skipped.
  const textOf = (e, seen) => [...e.childNodes].map((n) =>
    n.nodeType === 3 ? n.textContent
      : n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true" ? nameOf(n, seen) : "").join(" ");
  const nameOf = (e, seen) => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const referenced = (e.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((i) => nameOf(document.getElementById(i), seen)).filter(Boolean).join(" ");
    return referenced || e.getAttribute("aria-label") ||
      [...(e.labels || [])].map((l) => nameOf(l, seen)).filter(Boolean).join(" ") ||
      (["submit", "button", "reset"].includes(e.type) ? e.value : "") ||
      e.getAttribute("alt") ||
      (e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA" ? "" : textOf(e, seen)) ||
      e.getAttribute("title") || e.getAttribute("placeholder") || "";
  };
  const name = (e) => clean(nameOf(e, new Set()));

  // What an element means, not where it is: re-read before every action so a
  // handle whose node now plays another part (a re-rendered row, a reused
  // button) is refused rather than acted on.
  const guards = new Map();
  const EDITABLE = ["textbox", "searchbox", "combobox", "spinbutton", "password"];
  const guardOf = (e) => {
    // A field is judged on itself: suggestions appearing around it while the
    // agent types are expected. Anything else also on its row, form or
    // dialog, never the whole body, which changes constantly.
    const scope = EDITABLE.includes(role(e)) ? null
      : e.closest("form,dialog,[role=dialog],article,li,tr,[role=row]") ||
        (e.parentElement !== document.body ? e.parentElement : null);
    return JSON.stringify([role(e), name(e), e.value === undefined ? null : e.value,
      e.checked === undefined ? null : e.checked, e.selectedIndex === undefined ? null : e.selectedIndex,
      e.getAttribute("aria-expanded"), e.getAttribute("aria-checked"), e.getAttribute("aria-selected"),
      e.getAttribute("href"), clean(scope ? scope.innerText : "", 2000)]);
  };
  const enabledOptions = (e) => [...e.options].filter((o) => !o.disabled && !o.closest("optgroup[disabled]"));

  const describe = (e) => {
    const r = role(e);
    const row = { element: handleOf(e), role: r, name: name(e) };
    guards.set(row.element, guardOf(e));
    if (r === "password") {
      row.value = e.value ? "(set)" : "";
      row.actions = ["type"];
    } else if (r === "file") {
      row.actions = ["upload"];
    } else if (r === "select") {
      row.value = clean((e.selectedOptions && e.selectedOptions[0] || {}).text || "");
      const options = enabledOptions(e).slice(0, 50);
      row.options = options.map((o) => clean(o.text));
      row.option_values = options.map((o) => o.value);
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
    const guard = guards.get(handle);
    if (guard !== undefined && guard !== guardOf(e)) {
      return { error: "stale", message: "element " + handle + " changed since it was observed; observe again" };
    }
    return { e };
  };
  // A cheap content hash, so a client can tell whether an action changed the page.
  const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  // Text a person can see right now, top to bottom, not the whole document.
  const viewportText = (limit) => {
    const words = [];
    let length = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node;
    while ((node = walker.nextNode()) && length < limit) {
      const value = node.textContent.replace(/\s+/g, " ").trim();
      const parent = node.parentElement;
      if (!value || !parent || parent.closest("script,style,noscript,template") || !rendered(parent)) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
        words.push(value);
        length += value.length + 1;
      }
    }
    return words.join("\n").slice(0, limit);
  };

  const v1 = {
    version: "browser.v1",

    observe(opts) {
      const o = opts || {};
      const limit = Math.max(1, Math.min(o.limit || 150, 500));
      const cursor = Math.max(0, o.cursor || 0);
      const viewport = o.scope === "viewport";
      for (const [h, e] of nodes) if (!e.isConnected) { nodes.delete(h); guards.delete(h); }
      const all = [...document.querySelectorAll(SELECTOR)].filter(rendered)
        // A grid cell that holds a button is reached through the button.
        .filter((e) => role(e) !== "gridcell" || !e.querySelector("button,[role=button]"));
      const visible = all.filter(inViewport);
      const ordered = viewport ? visible : visible.concat(all.filter((e) => !inViewport(e)));
      const page = ordered.slice(cursor, cursor + limit).map(describe);
      const text = !document.body ? ""
        : viewport ? viewportText(6000)
        : document.body.innerText.replace(/\n{2,}/g, "\n").slice(0, 4000);
      const scroll = { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight };
      return {
        version: "browser.v1",
        url: location.href,
        title: document.title,
        text,
        scroll,
        elements: page,
        next_cursor: cursor + limit < ordered.length ? cursor + limit : null,
        fingerprint: hash(JSON.stringify([location.href, text, scroll.y,
          page.map((r) => [r.role, r.name, r.value, r.checked, r.expanded, r.disabled])])),
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

    // Unguarded: the value it just typed is the change. The guard is re-read
    // so the edit does not read as the element changing meaning.
    commitType(handle) {
      const e = nodes.get(handle);
      if (!e || !e.isConnected) return { error: "stale", message: "element " + handle + " is no longer on the page; observe again" };
      e.dispatchEvent(new Event("change", { bubbles: true }));
      guards.set(handle, guardOf(e));
      return { ok: true, value: clean(e.value !== undefined ? e.value : e.innerText, 200) };
    },

    // By value when given, which tells apart two options with one label.
    select(handle, label, value) {
      const found = lookup(handle);
      if (found.error) return found;
      const e = found.e;
      if (e.tagName !== "SELECT") return { error: "unsupported", message: handle + " is not a select" };
      const option = enabledOptions(e).find((o) => value != null ? o.value === value : clean(o.text) === label);
      if (!option) return { error: "no_option", message: JSON.stringify(value != null ? value : label) + " is not an enabled option of " + handle };
      e.value = option.value;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      guards.set(handle, guardOf(e));
      return { ok: true, value: clean(option.text) };
    },

    // Used for file uploads: the client resolves this to a node and calls
    // DOM.setFileInputFiles on it.
    node(handle) {
      const found = lookup(handle);
      return found.error ? null : found.e;
    },

    // Resolves once the page has rendered the input: two frames; for an
    // autocomplete field, until its suggestions are showing and have stopped
    // changing for 150ms, since many arrive over the network (at most 1s).
    settle(handle) {
      const e = handle ? nodes.get(handle) : null;
      const autocomplete = !!e && (e.getAttribute("role") === "combobox" ||
        (e.getAttribute("aria-autocomplete") || "none") !== "none" || !!e.list);
      const ids = ((e && (e.getAttribute("aria-controls") || e.getAttribute("aria-owns"))) || "").split(/\s+/).filter(Boolean);
      const roots = () => ids.length ? ids.map((i) => document.getElementById(i)).filter(Boolean) : [document.body];
      const shown = () => roots().some((root) =>
        [...root.querySelectorAll("[role=option]")].some((o) => rendered(o) && inViewport(o)));
      return new Promise((resolve) => {
        let done = false;
        let frames = 0;
        let quietTimer = null;
        const observer = autocomplete ? new MutationObserver(() => quiet()) : null;
        const finish = () => {
          if (done) return;
          done = true;
          if (observer) observer.disconnect();
          resolve({ ok: true });
        };
        const quiet = () => {
          clearTimeout(quietTimer);
          if (shown()) quietTimer = setTimeout(finish, 150);
        };
        setTimeout(finish, autocomplete ? 1000 : 50);
        if (observer) for (const root of roots()) observer.observe(root, { childList: true, subtree: true, characterData: true });
        const ready = () => {
          if (done) return;
          if (++frames < 2) return requestAnimationFrame(ready);
          if (!autocomplete) return finish();
          quiet();
        };
        requestAnimationFrame(ready);
      });
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
