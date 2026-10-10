import { AAuthDemo } from "@/components/demo/aauth-demo";
import { SCENARIOS } from "@/lib/demo/run";

import "./demo.css";

export const dynamic = "force-dynamic";

export default function DemoPage() {
  return <AAuthDemo scenarios={SCENARIOS.map((s) => ({ ...s }))} />;
}
