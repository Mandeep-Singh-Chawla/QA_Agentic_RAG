/**
 * RAG Source Agent — retrieves (and optionally summarizes) context from one
 * knowledge source: Jira / GitHub / Confluence / Xray.
 * Default: retrieve-only (no LLM) to stay under Gemini free-tier quotas.
 * Set QA_SOURCE_LLM=true to summarize with the lite model.
 */
import { initChatModel } from "langchain";
import type { VectorStore } from "@langchain/core/vectorstores";
import {
  LITE_MODEL,
  SOURCE_LLM_ENABLED,
  type SourceName,
} from "../core/config";
import {
  chunksToContext,
  retrieveForSource,
  type RetrievedChunk,
} from "../rag/retrieval";

export type AgentResult = {
  agent: SourceName;
  summary: string;
  chunks: RetrievedChunk[];
  citations: string[];
};

const ROLE: Record<SourceName, string> = {
  confluence:
    "You are the Confluence agent. Extract product requirements, acceptance criteria, and UX rules.",
  jira: "You are the JIRA agent. Extract stories, acceptance criteria, and ticket constraints.",
  github:
    "You are the GitHub agent. Extract API contracts, status codes, and engineering notes.",
  xray:
    "You are the Xray agent. Extract existing tests, coverage gaps, and regression risks.",
};

export async function runSourceAgent(
  store: VectorStore,
  source: SourceName,
  query: string
): Promise<AgentResult> {
  const chunks = await retrieveForSource(store, query, source, {
    fetchK: 6,
    topN: 3,
  });
  const citations = [
    ...new Set(chunks.map((c) => `${c.sourceSystem}/${c.title}`)),
  ];

  if (!chunks.length) {
    return {
      agent: source,
      summary: `No relevant ${source} documents found for this query.`,
      chunks: [],
      citations: [],
    };
  }

  // Free-tier default: skip per-source LLM call
  if (!SOURCE_LLM_ENABLED) {
    return {
      agent: source,
      summary: chunksToContext(chunks),
      chunks,
      citations,
    };
  }

  const model = await initChatModel(LITE_MODEL, {
    temperature: 0.2,
    maxOutputTokens: 1024,
  });

  const msg = await model.invoke([
    {
      role: "system",
      content:
        `${ROLE[source]}\n` +
        `Answer ONLY from the retrieved context. List concrete facts useful for QA. Be concise.`,
    },
    {
      role: "user",
      content: `User query: ${query}\n\nContext:\n${chunksToContext(chunks)}`,
    },
  ]);

  const summary =
    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

  return { agent: source, summary, chunks, citations };
}
