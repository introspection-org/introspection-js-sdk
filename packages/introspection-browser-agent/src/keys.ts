import { BrowserError } from "./types.js";

/** One `Input.dispatchKeyEvent` key, as Chromium expects it. */
export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** Set for keys that insert text, which makes the key down a `keyDown`. */
  text?: string;
}

export interface KeyChord {
  key: KeyDefinition;
  /** CDP modifier bits: Alt 1, Control 2, Meta 4, Shift 8. */
  modifiers: number;
}

const NAMED: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const MODIFIERS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

/** The named keys `press` accepts, besides single letters and digits. */
export const NAMED_KEYS: readonly string[] = Object.keys(NAMED);

/** At most this many chords per `press`, so one call cannot hold the page. */
export const MAX_PRESS_KEYS = 32;

function character(c: string, shift: boolean): KeyDefinition | null {
  if (/^[a-z]$/i.test(c)) {
    const upper = c.toUpperCase();
    return {
      key: shift ? upper : c.toLowerCase(),
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: shift ? upper : c.toLowerCase(),
    };
  }
  if (/^[0-9]$/.test(c)) {
    return { key: c, code: `Digit${c}`, keyCode: c.charCodeAt(0), text: c };
  }
  return null;
}

/**
 * Parses `"Enter"`, `"ArrowLeft"`, `"a"`, `"Shift+Tab"` or `"Control+a"`.
 * Anything else is refused: arbitrary text goes through `act` `type`.
 */
export function parseChord(chord: string): KeyChord {
  const parts = chord.split("+");
  const name = parts.pop() ?? "";
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (bit === undefined) {
      throw new BrowserError("invalid_argument", `unknown modifier "${part}"`);
    }
    modifiers |= bit;
  }
  const named = NAMED[name];
  const key = named ?? character(name, (modifiers & MODIFIERS.Shift!) !== 0);
  if (!key) {
    throw new BrowserError(
      "invalid_argument",
      `unknown key "${name}"; use a letter, a digit or one of ${NAMED_KEYS.join(", ")}`,
    );
  }
  // A shortcut types nothing: Control+a selects rather than inserting "a".
  const shortcut =
    (modifiers & (MODIFIERS.Control! | MODIFIERS.Meta! | MODIFIERS.Alt!)) !== 0;
  return {
    key: shortcut ? { ...key, text: undefined } : key,
    modifiers,
  };
}
