import { PapDemo } from "@/components/pap-demo";
import { SCENARIOS } from "@/lib/atlas/demo";

import "introspection-example-travel-demo-ui/demo.css";

export const dynamic = "force-dynamic";

export default function Page() {
  return <PapDemo scenarios={SCENARIOS} />;
}
