import { recording } from "@introspection-ai/eval-simulate/mcp/testing";
import { RECORD } from "./client.js";

export const { globalSetup, globalTeardown } = recording(RECORD);
