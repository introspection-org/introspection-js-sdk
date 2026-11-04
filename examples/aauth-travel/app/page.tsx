import { AAuthDemo } from "@/components/demo/aauth-demo";
import { scenarios } from "@/lib/demo/run";

import "introspection-example-travel-demo-ui/demo.css";

export const dynamic = "force-dynamic";

export default function Page() {
  return <AAuthDemo scenarios={scenarios()} />;
}
