import { AAuthDemo } from "@/components/demo/aauth-demo";
import { scenarios } from "@/lib/demo/run";

import "./demo.css";

export const dynamic = "force-dynamic";

export default function Page() {
  return <AAuthDemo scenarios={scenarios()} />;
}
