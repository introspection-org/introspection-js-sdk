import type { TracerProvider } from "@opentelemetry/api";
import {
  SimpleSpanProcessor,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoOTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node";
import { IncrementalIdGenerator, TestSpanExporter } from "../testing";

interface OpenInferenceInstrumentation {
  setTracerProvider(provider: TracerProvider): void;
  enable(): void;
  disable(): void;
  manuallyInstrument(module: unknown): void;
}

type InstrumentationClass = new (
  ...args: any[]
) => OpenInferenceInstrumentation;

let OpenAIInstrumentationClass: InstrumentationClass | null = null;
let LangChainInstrumentationClass: InstrumentationClass | null = null;
let CallbackManagerModule: Record<string, unknown> | null = null;
let VercelOpenInferenceModule: {
  OpenInferenceSimpleSpanProcessor: new (options: {
    exporter: unknown;
    spanFilter?: (span: unknown) => boolean;
  }) => { forceFlush(): Promise<void> };
  isOpenInferenceSpan: (span: unknown) => boolean;
} | null = null;

function isModuleNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
  );
}

export async function loadOpenAIInstrumentation(): Promise<InstrumentationClass | null> {
  if (OpenAIInstrumentationClass) return OpenAIInstrumentationClass;
  try {
    const mod = await import("@arizeai/openinference-instrumentation-openai");
    const instrClass = mod.OpenAIInstrumentation as InstrumentationClass;
    OpenAIInstrumentationClass = instrClass;
    return instrClass;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function loadVercelOpenInference(): Promise<
  typeof VercelOpenInferenceModule
> {
  if (VercelOpenInferenceModule) return VercelOpenInferenceModule;
  try {
    const mod = await import("@arizeai/openinference-vercel");
    VercelOpenInferenceModule = mod as typeof VercelOpenInferenceModule;
    return VercelOpenInferenceModule;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function loadLangChainInstrumentation(): Promise<{
  LangChainInstrumentation: InstrumentationClass;
  CallbackManagerModule: Record<string, unknown>;
} | null> {
  if (LangChainInstrumentationClass && CallbackManagerModule) {
    return {
      LangChainInstrumentation: LangChainInstrumentationClass,
      CallbackManagerModule,
    };
  }
  try {
    const instrMod =
      await import("@arizeai/openinference-instrumentation-langchain");
    const cbMod = await import("@langchain/core/callbacks/manager");
    const instrClass =
      instrMod.LangChainInstrumentation as InstrumentationClass;
    const cbModule = cbMod as Record<string, unknown>;
    LangChainInstrumentationClass = instrClass;
    CallbackManagerModule = cbModule;
    return {
      LangChainInstrumentation: instrClass,
      CallbackManagerModule: cbModule,
    };
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export interface CaptureOpenInferenceSpans {
  exporter: TestSpanExporter;
  processor: IntrospectionSpanProcessor;
  provider: NodeTracerProvider;
  cleanup: () => Promise<void>;
}

export async function createArizeProvider(): Promise<CaptureOpenInferenceSpans> {
  const InstrClass = await loadOpenAIInstrumentation();
  if (!InstrClass) {
    throw new Error(
      "OpenInference OpenAI instrumentation not installed. " +
        "Install with: pnpm add -D @arizeai/openinference-instrumentation-openai",
    );
  }

  if (!process.env.ARIZE_SPACE_KEY || !process.env.ARIZE_API_KEY) {
    throw new Error(
      "Missing Arize creds: set ARIZE_SPACE_KEY and ARIZE_API_KEY",
    );
  }

  const arizeProcessor = new SimpleSpanProcessor(
    new ProtoOTLPTraceExporter({
      url: "https://otlp.arize.com/v1/traces",
      headers: {
        space_id: process.env.ARIZE_SPACE_KEY,
        api_key: process.env.ARIZE_API_KEY,
      },
    }),
  );

  const exporter = new TestSpanExporter();
  const introspectionProcessor = new IntrospectionSpanProcessor({
    token: process.env.INTROSPECTION_TOKEN,
    advanced: {
      spanExporter: exporter,
    },
  });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "openinference.project.name": "dual-export-test",
    }),
    idGenerator: new IncrementalIdGenerator(),
    spanProcessors: [arizeProcessor, introspectionProcessor],
  });
  provider.register();

  const instrumentation = new InstrClass();
  instrumentation.setTracerProvider(provider);
  instrumentation.enable();
  const openaiModule = await import("openai");
  instrumentation.manuallyInstrument(
    (openaiModule as { default?: unknown }).default ?? openaiModule,
  );

  return {
    exporter,
    processor: introspectionProcessor,
    provider,
    cleanup: async () => {
      instrumentation.disable();
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

export async function createBraintrustProvider(): Promise<CaptureOpenInferenceSpans> {
  const InstrClass = await loadOpenAIInstrumentation();
  if (!InstrClass) {
    throw new Error(
      "OpenInference OpenAI instrumentation not installed. " +
        "Install with: pnpm add -D @arizeai/openinference-instrumentation-openai",
    );
  }

  const braintrustProcessor = new IntrospectionSpanProcessor({
    token: process.env.BRAINTRUST_API_KEY,
    advanced: {
      baseUrl: "https://api.braintrust.dev/otel/v1/traces",
      additionalHeaders: {
        "x-bt-parent": "project_name:dual-export-test",
      },
    },
  });

  const exporter = new TestSpanExporter();
  const introspectionProcessor = new IntrospectionSpanProcessor({
    token: process.env.INTROSPECTION_TOKEN,
    advanced: {
      spanExporter: exporter,
    },
  });

  const provider = new NodeTracerProvider({
    idGenerator: new IncrementalIdGenerator(),
    spanProcessors: [braintrustProcessor, introspectionProcessor],
  });
  provider.register();

  const instrumentation = new InstrClass();
  instrumentation.setTracerProvider(provider);
  instrumentation.enable();
  const openaiModule = await import("openai");
  instrumentation.manuallyInstrument(
    (openaiModule as { default?: unknown }).default ?? openaiModule,
  );

  return {
    exporter,
    processor: introspectionProcessor,
    provider,
    cleanup: async () => {
      instrumentation.disable();
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

export async function createLangfuseProvider(): Promise<CaptureOpenInferenceSpans> {
  const InstrClass = await loadOpenAIInstrumentation();
  if (!InstrClass) {
    throw new Error(
      "OpenInference OpenAI instrumentation not installed. " +
        "Install with: pnpm add -D @arizeai/openinference-instrumentation-openai",
    );
  }

  const langfuseAuth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
  ).toString("base64");

  const langfuseBaseUrl =
    process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

  const langfuseProcessor = new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: `${langfuseBaseUrl}/api/public/otel/v1/traces`,
      headers: {
        Authorization: `Basic ${langfuseAuth}`,
      },
    }),
  );

  const exporter = new TestSpanExporter();
  const introspectionProcessor = new IntrospectionSpanProcessor({
    token: process.env.INTROSPECTION_TOKEN,
    advanced: {
      spanExporter: exporter,
    },
  });

  const provider = new NodeTracerProvider({
    idGenerator: new IncrementalIdGenerator(),
    spanProcessors: [langfuseProcessor, introspectionProcessor],
  });
  provider.register();

  const instrumentation = new InstrClass();
  instrumentation.setTracerProvider(provider);
  instrumentation.enable();
  const openaiModule = await import("openai");
  instrumentation.manuallyInstrument(
    (openaiModule as { default?: unknown }).default ?? openaiModule,
  );

  return {
    exporter,
    processor: introspectionProcessor,
    provider,
    cleanup: async () => {
      instrumentation.disable();
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

export async function createLangChainProvider(): Promise<CaptureOpenInferenceSpans> {
  const lcResult = await loadLangChainInstrumentation();
  if (!lcResult) {
    throw new Error(
      "OpenInference LangChain instrumentation not installed. " +
        "Install with: pnpm add -D @arizeai/openinference-instrumentation-langchain @langchain/core",
    );
  }

  const {
    LangChainInstrumentation: LCInstrClass,
    CallbackManagerModule: CBModule,
  } = lcResult;

  const langsmithProcessor = new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: "https://api.smith.langchain.com/otel/v1/traces",
      headers: {
        "x-api-key": process.env.LANGSMITH_API_KEY || "",
        "Langsmith-Project":
          process.env.LANGSMITH_PROJECT || "dual-export-test",
      },
    }),
  );

  const exporter = new TestSpanExporter();
  const introspectionProcessor = new IntrospectionSpanProcessor({
    token: process.env.INTROSPECTION_TOKEN,
    advanced: {
      spanExporter: exporter,
    },
  });

  const provider = new NodeTracerProvider({
    spanProcessors: [langsmithProcessor, introspectionProcessor],
  });
  provider.register();

  const instrumentation = new LCInstrClass();
  instrumentation.setTracerProvider(provider);
  instrumentation.manuallyInstrument(CBModule);
  instrumentation.enable();

  return {
    exporter,
    processor: introspectionProcessor,
    provider,
    cleanup: async () => {
      instrumentation.disable();
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

export interface CaptureVercelSpans {
  exporter: TestSpanExporter;
  processor: IntrospectionSpanProcessor;
  provider: NodeTracerProvider;
  vercelProcessor: { forceFlush(): Promise<void> };
  cleanup: () => Promise<void>;
}

export async function createVercelProvider(): Promise<CaptureVercelSpans> {
  const vercelMod = await loadVercelOpenInference();
  if (!vercelMod) {
    throw new Error(
      "OpenInference Vercel not installed. " +
        "Install with: pnpm add -D @arizeai/openinference-vercel",
    );
  }

  if (!process.env.ARIZE_SPACE_KEY || !process.env.ARIZE_API_KEY) {
    throw new Error(
      "Missing Arize creds: set ARIZE_SPACE_KEY and ARIZE_API_KEY",
    );
  }

  const { OpenInferenceSimpleSpanProcessor, isOpenInferenceSpan } = vercelMod;

  const vercelProcessor = new OpenInferenceSimpleSpanProcessor({
    exporter: new ProtoOTLPTraceExporter({
      url: "https://otlp.arize.com/v1/traces",
      headers: {
        space_id: process.env.ARIZE_SPACE_KEY,
        api_key: process.env.ARIZE_API_KEY,
      },
    }),
    spanFilter: isOpenInferenceSpan,
  });

  const exporter = new TestSpanExporter();
  const introspectionProcessor = new IntrospectionSpanProcessor({
    token: process.env.INTROSPECTION_TOKEN,
    advanced: {
      spanExporter: exporter,
    },
  });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "openinference.project.name": "vercel-dual-export-test",
    }),
    idGenerator: new IncrementalIdGenerator(),
    spanProcessors: [vercelProcessor as any, introspectionProcessor],
  });
  provider.register();

  return {
    exporter,
    processor: introspectionProcessor,
    provider,
    vercelProcessor,
    cleanup: async () => {
      await vercelProcessor.forceFlush();
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}
