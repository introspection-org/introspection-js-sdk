// Acme's own Person Server. The platform POSTs each pending booking mission
// here with a single-use capability; Acme decides under its own policy and
// records the decision at the platform's Person Server API. Nothing about
// Acme's policy or org chart lives in the platform.
import { findOffer } from "./catalog.mjs";

export function createPersonServer({
  policy,
  controlPlaneUrl,
  fetchImpl = fetch,
  notify = console.log,
}) {
  const pending = new Map();

  async function decide(missionId, verdict) {
    const mission = pending.get(missionId);
    if (!mission) return { status: 404, body: { error: "no pending mission" } };
    const response = await fetchImpl(
      `${controlPlaneUrl}/v1/person-server/missions/${missionId}/decision`,
      {
        method: "POST",
        headers: {
          authorization: `Capability ${mission.capability}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          verdict,
          granted_permissions:
            verdict === "approved" ? mission.requested_permissions : {},
        }),
      },
    );
    if (!response.ok)
      return {
        status: 502,
        body: { error: `the platform answered ${response.status}` },
      };
    pending.delete(missionId);
    return { status: 200, body: { mission_id: missionId, verdict } };
  }

  function overPolicy(offer) {
    if (!offer) return "the offer is unknown";
    if (offer.kind !== "hotel") return null;
    const cap = policy.nightly_caps[offer.city];
    if (cap === undefined || offer.nightly_rate <= cap) return null;
    return `${offer.name} at $${offer.nightly_rate}/night is over Acme's $${cap} cap for ${offer.city}`;
  }

  return {
    pending,
    decide,
    async receive(mission) {
      const offer = findOffer(mission.requested_permissions?.resource);
      const reason = overPolicy(offer);
      pending.set(mission.mission_id, { ...mission, offer, reason });
      if (reason === null) return decide(mission.mission_id, "approved");
      notify(
        `To ${policy.approver}: approval needed. ${reason}. Decide at /approvals.`,
      );
      return {
        status: 202,
        body: { mission_id: mission.mission_id, awaiting: policy.approver },
      };
    },
  };
}
