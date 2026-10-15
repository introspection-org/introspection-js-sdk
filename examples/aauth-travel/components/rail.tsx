"use client";

import { useEffect, useState } from "react";

export interface RailStep {
  id: string;
  title: string;
  platform: boolean;
}

/** The step list, shading the step being read. */
export function Rail({ steps }: { steps: RailStep[] }) {
  const [current, setCurrent] = useState(steps[0]?.id);

  useEffect(() => {
    const sections = steps
      .map((step) => document.getElementById(step.id))
      .filter((section): section is HTMLElement => section !== null);
    // The current step is the last one whose top has passed a line a third of
    // the way down the window.
    const update = () => {
      const line = window.innerHeight / 3;
      let id = sections[0]?.id;
      for (const section of sections)
        if (section.getBoundingClientRect().top <= line) id = section.id;
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2)
        id = sections[sections.length - 1]?.id;
      setCurrent(id);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [steps]);

  useEffect(() => {
    document
      .querySelector(`.rail a[href="#${current}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <nav className="rail">
      <div className="brand">Flight Sector</div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.id}>
            <a
              href={`#${step.id}`}
              className={step.id === current ? "current" : undefined}
              aria-current={step.id === current ? "step" : undefined}
            >
              <span
                className={step.platform ? "dot dot-platform" : "dot"}
                title={
                  step.platform
                    ? "Happens inside the platform"
                    : "Flight Sector's side"
                }
              />
              <span className="rail-index">{index + 1}</span>
              {step.title}
            </a>
          </li>
        ))}
      </ol>
      <div className="legend">
        <span>
          <span className="dot dot-platform" /> inside the platform
        </span>
      </div>
    </nav>
  );
}
