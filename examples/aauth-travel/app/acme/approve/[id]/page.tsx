import { headers } from "next/headers";

import { approvalSummary } from "@/lib/acme/person-server";
import { PERSON_SERVER_URL } from "@/lib/origins";

import { ApprovalForm } from "./approval-form";

export const dynamic = "force-dynamic";

export default async function ApprovePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const approval = approvalSummary(id);
  if (!approval) {
    return (
      <div className="acme-card">
        <h1>This request isn&apos;t here any more</h1>
        <p className="acme-muted">
          It may have expired. Ask the traveller to try again.
        </p>
      </div>
    );
  }
  // On Acme's own origin the page is /approve/{id}; elsewhere it is under /acme.
  const onAcme =
    (await headers()).get("host") === new URL(PERSON_SERVER_URL).host;
  return (
    <div className="acme-card">
      <p className="acme-muted">For {approval.approver}</p>
      <h1>
        {approval.traveller} wants to book {approval.item}
      </h1>
      <p className="acme-muted">Why this needs your approval:</p>
      <ul className="acme-reasons">
        {approval.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <ApprovalForm
        decisionUrl={`${onAcme ? "" : "/acme"}/ps/approvals/${id}`}
        sentTo={approval.sentTo}
        initialStatus={approval.status}
      />
    </div>
  );
}
