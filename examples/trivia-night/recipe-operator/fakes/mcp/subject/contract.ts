import { contractOf } from "@introspection-ai/eval-simulate/mcp";
import tools from "./tools.ts";

export const contract = contractOf(tools, { say: { format: "text" } } as const);
