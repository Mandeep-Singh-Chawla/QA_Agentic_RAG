/**
 * Retrieval layer (diagram: query embedding → similarity search → rerank → context).
 * Backends: MemoryVectorStore or Qdrant (see VECTOR_BACKEND).
 */
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { VectorStore } from "@langchain/core/vectorstores";
import path from "node:path";
import type { SourceName } from "./config";
import { RERANK_ENABLED, RERANK_MODEL } from "./config";

export type RetrievedChunk = {
  content: string;
  sourceSystem: string;
  title: string;
  sourcePath: string;
};

const reranker = new ChatGoogleGenerativeAI({
  model: RERANK_MODEL,
  temperature: 0,
});

async function llmRerank(
  query: string,
  candidates: RetrievedChunk[],
  topN: number
): Promise<RetrievedChunk[]> {
  if (candidates.length <= topN) return candidates;

  const numbered = candidates
    .map((c, i) => `[${i}] (${c.sourceSystem}/${c.title}) ${c.content.slice(0, 400)}`)
    .join("\n\n");

  const pick = await reranker.invoke(
    `Return ONLY a JSON array of the ${topN} most relevant passage indexes for the query.\n` +
      `Query: ${query}\n\nPassages:\n${numbered}`
  );
  const text = typeof pick.content === "string" ? pick.content : "";
  const match = text.match(/\[[\d,\s]+\]/);
  const indexes: number[] = match
    ? JSON.parse(match[0])
    : candidates.map((_, i) => i).slice(0, topN);

  const seen = new Set<number>();
  const ranked: RetrievedChunk[] = [];
  for (const i of indexes) {
    if (i >= 0 && i < candidates.length && !seen.has(i)) {
      seen.add(i);
      ranked.push(candidates[i]);
    }
    if (ranked.length === topN) break;
  }
  for (let i = 0; ranked.length < topN && i < candidates.length; i++) {
    if (!seen.has(i)) ranked.push(candidates[i]);
  }
  return ranked;
}

export async function retrieveForSource(
  store: VectorStore,
  query: string,
  source: SourceName | "all",
  opts: { fetchK?: number; topN?: number; rerank?: boolean } = {}
): Promise<RetrievedChunk[]> {
  const fetchK = opts.fetchK ?? 10;
  const topN = opts.topN ?? 4;
  const doRerank = opts.rerank ?? RERANK_ENABLED;

  let candidates = await store.similaritySearch(query, fetchK);
  if (source !== "all") {
    candidates = candidates.filter(
      (d) => String(d.metadata.sourceSystem ?? "") === source
    );
    // If filter emptied the list, broaden once
    if (candidates.length === 0) {
      candidates = (await store.similaritySearch(query, fetchK)).filter(
        (d) => String(d.metadata.sourceSystem ?? "") === source
      );
    }
  }

  const mapped: RetrievedChunk[] = candidates.map((d) => ({
    content: d.pageContent,
    sourceSystem: String(d.metadata.sourceSystem ?? "unknown"),
    title: String(d.metadata.title ?? path.basename(String(d.metadata.source ?? "doc"))),
    sourcePath: String(d.metadata.source ?? ""),
  }));

  return doRerank ? llmRerank(query, mapped, topN) : mapped.slice(0, topN);
}

export function chunksToContext(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return "(no relevant chunks)";
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.sourceSystem}/${c.title}\n${c.content}`
    )
    .join("\n\n---\n\n");
}
