/**
 * How Acme reaches an approver: an email with a link and a six-digit code.
 * Sent through Resend when RESEND_API_KEY is set; otherwise printed to the
 * server console, so a local run needs no mail account.
 */
import "server-only";

const RESEND_URL = "https://api.resend.com/emails";
const FROM =
  process.env.ACME_MAIL_FROM ??
  "Acme Travel Approvals <approvals@acme.example>";

export interface ApprovalEmail {
  to: string;
  approverName: string;
  travellerName: string;
  item: string;
  reasons: string[];
  link: string;
  code: string;
}

/** Every email Acme sent in this process, newest last: the demo page shows them as each person's inbox. */
const sent = ((
  globalThis as unknown as { __acmeInbox?: ApprovalEmail[] }
).__acmeInbox ??= []);

export function inbox(): ApprovalEmail[] {
  return sent;
}

export function clearInbox(): void {
  sent.length = 0;
}

// #region email
export async function sendApprovalEmail(email: ApprovalEmail): Promise<void> {
  sent.push(email);
  const subject = `Approve ${email.travellerName}'s booking: ${email.item}`;
  const text = [
    `Hi ${email.approverName},`,
    "",
    `${email.travellerName} asked Flight Sector to book ${email.item}. It needs your approval:`,
    ...email.reasons.map((reason) => `  - ${reason}`),
    "",
    `Review it here: ${email.link}`,
    `Your code: ${email.code}`,
    "",
    "The code works once and expires in 15 minutes.",
  ].join("\n");

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.info(
      `[acme] approval email to ${email.to}\n${subject}\n\n${text}\n`,
    );
    return;
  }
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to: [email.to], subject, text }),
  });
  if (!response.ok)
    throw new Error(`Resend refused the email: ${response.status}`);
}
// #endregion
