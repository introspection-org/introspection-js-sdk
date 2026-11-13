"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

const atEnd = (pane: HTMLDivElement) =>
  pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;

/**
 * Keeps the chat and the two panes at their ends as the page updates, unless
 * the reader scrolled up to read. `chat` changes whenever the chat grows,
 * `update` on every new snapshot, and `picked` is the turn the reader chose
 * to see the requests of, or null to follow the latest.
 */
export function useFollow(chat: string, update: unknown, picked: unknown) {
  const chatBox = useRef<HTMLDivElement>(null);
  const seenPane = useRef<HTMLDivElement>(null);
  const detailsPane = useRef<HTMLDivElement>(null);
  const seenAtEnd = useRef(true);
  const detailsAtEnd = useRef(true);

  // Follow the chat as each reply streams in, not only when a new one starts.
  useEffect(() => {
    const box = chatBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [chat]);
  // Every update keeps a pane that was at its end there, after layout, so a
  // card that grows once rendered is not left half below the edge. Picking a
  // turn moves only the request details, to the top of that turn's requests.
  useLayoutEffect(() => {
    const seen = seenPane.current;
    if (seen && seenAtEnd.current) seen.scrollTop = seen.scrollHeight;
    const details = detailsPane.current;
    if (details && picked === null && detailsAtEnd.current)
      details.scrollTop = details.scrollHeight;
  }, [update, picked]);
  useEffect(() => {
    // Following the latest again follows the end again.
    detailsAtEnd.current = picked === null;
    if (picked !== null) detailsPane.current?.scrollTo({ top: 0 });
  }, [picked]);

  return {
    chatBox,
    seenPane,
    detailsPane,
    onSeenScroll: (pane: HTMLDivElement) => {
      seenAtEnd.current = atEnd(pane);
    },
    onDetailsScroll: (pane: HTMLDivElement) => {
      detailsAtEnd.current = atEnd(pane);
    },
  };
}
