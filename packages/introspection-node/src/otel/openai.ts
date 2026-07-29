/** Privacy-preserving OpenAI embeddings instrumentation. */

import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from "openai/resources/embeddings";

/** The narrow OpenAI client surface required by the embedding wrapper. */
export interface OpenAIEmbeddingsClient {
  embeddings: {
    create(params: EmbeddingCreateParams): Promise<CreateEmbeddingResponse>;
  };
}

export interface TracedEmbeddingsOptions {
  /** GenAI provider name. Defaults to `openai`. */
  providerName?: string;
}

function setResponseAttributes(
  span: Span,
  response: CreateEmbeddingResponse,
): void {
  span.setAttribute("gen_ai.response.model", response.model);
  span.setAttribute("gen_ai.usage.input_tokens", response.usage.prompt_tokens);

  const firstEmbedding = response.data[0]?.embedding;
  if (Array.isArray(firstEmbedding)) {
    span.setAttribute(
      "gen_ai.embeddings.dimension.count",
      firstEmbedding.length,
    );
  }
  span.setStatus({ code: SpanStatusCode.OK });
}

/**
 * Call `client.embeddings.create` and emit a metadata-only GenAI span.
 *
 * Inputs and embedding vectors are deliberately never attached to the span.
 */
export async function tracedEmbeddingsCreate(
  tracer: Tracer,
  client: OpenAIEmbeddingsClient,
  params: EmbeddingCreateParams,
  options: TracedEmbeddingsOptions = {},
): Promise<CreateEmbeddingResponse> {
  const providerName = options.providerName ?? "openai";
  const span = tracer.startSpan(`embeddings ${params.model}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.system": providerName,
      "gen_ai.provider.name": providerName,
      "gen_ai.operation.name": "embeddings",
      "gen_ai.request.model": params.model,
      "openinference.span.kind": "EMBEDDING",
      ...(params.dimensions !== undefined
        ? { "gen_ai.embeddings.dimension.count": params.dimensions }
        : undefined),
      ...(params.encoding_format
        ? { "gen_ai.request.encoding_formats": [params.encoding_format] }
        : undefined),
    },
  });

  try {
    return await context.with(
      trace.setSpan(context.active(), span),
      async () => {
        const response = await client.embeddings.create(params);
        setResponseAttributes(span, response);
        return response;
      },
    );
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error) span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
}
