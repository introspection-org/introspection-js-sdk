import { redirect } from "next/navigation";

/** The demo moved to `/`; old links still land on it. */
export default function DemoPage() {
  redirect("/");
}
