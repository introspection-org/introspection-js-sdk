// C3: the bank's sport questions are mostly Australian and British; at each
// level only three US and two general sport questions are left.
import type { World } from "./base.ts";
import { cellKey } from "./bank.ts";

export default function usSportScarce(world: World) {
  for (let d = 1; d <= 5; d++) {
    world["question-bank"].supply[cellKey("sport", "US", d)] = 3;
    world["question-bank"].supply[cellKey("sport", "general", d)] = 2;
  }
}
