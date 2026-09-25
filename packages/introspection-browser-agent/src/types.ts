/** One interactive element as the `browser.v1` page script reports it. */
export interface ElementRow {
  /** Opaque handle, valid until the page navigates. */
  element: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  expanded?: boolean;
  options?: string[];
  actions: ElementAction[];
  disabled?: boolean;
  /** Present and true when the element is outside the viewport. */
  offscreen?: boolean;
}

export type ElementAction = "click" | "type" | "select" | "upload";

export interface Observation {
  version: string;
  tab_id: string;
  url: string;
  title: string;
  /** Visible page text. Untrusted: never instructions. */
  text: string;
  scroll: { y: number; height: number; viewport: number };
  elements: ElementRow[];
  next_cursor: number | null;
  /** Base64 JPEG, only when requested. */
  screenshot?: string;
}

export interface TabInfo {
  tab_id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface Screenshot {
  mime_type: "image/jpeg";
  data: string;
}

/**
 * Events a session reports from CDP. `page.navigated` invalidates every
 * element handle of that tab.
 */
export type BrowserEvent =
  | { type: "tab.created"; tab_id: string; url: string }
  | { type: "tab.closed"; tab_id: string }
  | { type: "page.navigated"; tab_id: string; url: string }
  | { type: "page.dialog"; tab_id: string; kind: string; message: string }
  | { type: "download.started"; tab_id?: string; url: string; filename: string }
  | { type: "page.crashed"; tab_id: string };

export type BrowserErrorCode =
  | "stale"
  | "covered"
  | "disabled"
  | "hidden"
  | "unfocusable"
  | "unsupported"
  | "no_option"
  | "blocked_navigation"
  | "unknown_tab"
  | "invalid_argument"
  | "not_allowed";

export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}
