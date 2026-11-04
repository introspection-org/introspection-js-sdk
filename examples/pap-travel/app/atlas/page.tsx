import { PapDemo } from "@/components/pap-demo";
import { SAM_ASKS } from "@/lib/atlas/demo";
import { ATLAS_URL, COMPANY_URL } from "@/lib/origins";

import "introspection-example-travel-demo-ui/demo.css";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <PapDemo
      prompts={[{ title: "QF74 is delayed", prompt: SAM_ASKS }]}
      hosts={{
        "Flight Sector": new URL(COMPANY_URL).host,
        Atlas: new URL(ATLAS_URL).host,
      }}
      companyUrl={COMPANY_URL}
    />
  );
}
