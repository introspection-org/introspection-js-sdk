"use client";

import { useState } from "react";

export interface RenderedSource {
  label: string;
  origin: string;
  kind: "example" | "recipe" | "contract";
  language: string;
  html: string;
}

export function Sources({ sources }: { sources: RenderedSource[] }) {
  const [active, setActive] = useState(0);
  const current = sources[active];
  return (
    <div className="sources">
      <div className="tabs" role="tablist">
        {sources.map((source, index) => (
          <button
            key={source.origin + source.label}
            role="tab"
            aria-selected={index === active}
            className={`tab tab-${source.kind}`}
            onClick={() => setActive(index)}
          >
            {source.label}
          </button>
        ))}
      </div>
      <div className="origin">{current.origin}</div>
      <div
        className={`code code-${current.language}`}
        dangerouslySetInnerHTML={{ __html: current.html }}
      />
    </div>
  );
}
