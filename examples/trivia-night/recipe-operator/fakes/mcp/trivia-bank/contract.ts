import { contractOf } from "@introspection-ai/eval-simulate/mcp";
import { answers } from "./answers.ts";
import tools from "./tools.ts";

export const contract = contractOf(tools, answers);
export type Contract = typeof contract;
