import "server-only";

import { createHighlighter, type Highlighter } from "shiki";

const LANGS = ["ts", "tsx", "js", "json", "yaml", "markdown"] as const;

let highlighter: Promise<Highlighter> | undefined;

function load(): Promise<Highlighter> {
  highlighter ??= createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [...LANGS],
  });
  return highlighter;
}

export async function highlight(
  code: string,
  language: string,
): Promise<string> {
  const shiki = await load();
  const lang = shiki.getLoadedLanguages().includes(language)
    ? language
    : "text";
  return shiki.codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}
