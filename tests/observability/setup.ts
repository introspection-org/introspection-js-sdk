import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";

declare global {
  var __testTracerProvider: NodeTracerProvider | undefined;
}

async function setup() {
  try {
    const { OpenAIInstrumentation } =
      await import("@arizeai/openinference-instrumentation-openai");

    const provider = new NodeTracerProvider();
    provider.register();

    registerInstrumentations({
      instrumentations: [new OpenAIInstrumentation()],
      tracerProvider: provider,
    });

    globalThis.__testTracerProvider = provider;
    console.log("[setup] OpenInference instrumentation registered");
  } catch (e) {
    console.log("[setup] OpenInference instrumentation not available:", e);
  }
}

export default setup();
