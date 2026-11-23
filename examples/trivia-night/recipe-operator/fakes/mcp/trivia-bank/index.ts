import { contract } from "./contract.ts";
import { register } from "./handlers.ts";
import manifest from "./manifest.json" with { type: "json" };

export { contract, manifest, register };
