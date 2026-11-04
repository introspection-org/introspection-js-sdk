import { PapDemo } from "@/components/pap-demo";
import { SCENARIOS } from "@/lib/atlas/demo";
import { ATLAS_URL, COMPANY_URL } from "@/lib/origins";

import "introspection-example-travel-demo-ui/demo.css";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <PapDemo
      scenarios={SCENARIOS}
      hosts={{
        "Flight Sector": new URL(COMPANY_URL).host,
        Atlas: new URL(ATLAS_URL).host,
      }}
      companyUrl={COMPANY_URL}
    />
  );
}
