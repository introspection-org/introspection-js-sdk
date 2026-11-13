"use client";

import type { ReactNode } from "react";

/**
 * Where something stands for the person holding the phone, while someone else
 * decides it: styled as the approval cards, with no buttons, since the person
 * it is shown to is not the one who answers.
 */
export function StatusCard(props: {
  /** Who it is about, as the card's head: "Dana · Acme". */
  who: string;
  /** What is happening: "Waiting on Dana at Acme to approve the trip budget". */
  title: ReactNode;
  detail?: ReactNode;
  tone: "wait" | "ok" | "no";
  /** The person it is about, for their colour: `mail-dana`. */
  className?: string;
}) {
  const { who, title, detail, tone, className = "" } = props;
  return (
    <div
      className={`mail status-card status-${tone} ${className}`}
      role="status"
    >
      <div className="mail-head">
        <span className="mail-to">
          <span className="mail-avatar" aria-hidden>
            {who.charAt(0)}
          </span>
          {who}
        </span>
      </div>
      <div className="mail-item status-title">{title}</div>
      {detail && <div className="status-detail">{detail}</div>}
    </div>
  );
}
