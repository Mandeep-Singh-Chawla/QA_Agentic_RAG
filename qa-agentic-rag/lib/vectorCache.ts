import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { Document } from "@langchain/core/documents";
import type { Embeddings } from "@langchain/core/embeddings";
import type { VectorStore } from "@langchain/core/vectorstores";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_CACHE_DIR =
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "qa-docs",
    "cache"
  ) + path.sep;

const pathJoin = (dir: string, file: string) =>
  dir.endsWith("/") || dir.endsWith(path.sep)
    ? `${dir}${file}`
    : path.join(dir, file);

export function makeEmbeddings() {
  return new GoogleGenerativeAIEmbeddings({
    model: "gemini-embedding-001",
    maxRetries: 8,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Embed documents into any LangChain VectorStore (memory or Qdrant)
 * with Gemini free-tier batching + disk cache of vectors.
 */
export async function addDocumentsCached(
  vectorStore: VectorStore,
  embeddings: Embeddings,
  splits: Document[],
  cacheKey: string,
  batchSize = 90,
  cacheDir = DEFAULT_CACHE_DIR
): Promise<number> {
  const cachePath = pathJoin(cacheDir, `${cacheKey}.json`);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const docs = cached.docs.map(
      (d: { pageContent: string; metadata: Record<string, unknown> }) =>
        new Document(d)
    );
    await vectorStore.addVectors(cached.vectors, docs);
    console.log(
      `Loaded ${docs.length} cached embeddings for ${cacheKey}`
    );
    return docs.length;
  }

  const allVectors: number[][] = [];
  const allDocs: Document[] = [];

  for (let i = 0; i < splits.length; i += batchSize) {
    const batch = splits.slice(i, i + batchSize);
    const vectors = await embeddings.embedDocuments(
      batch.map((d) => d.pageContent)
    );
    await vectorStore.addVectors(vectors, batch);
    allVectors.push(...vectors);
    allDocs.push(...batch);
    console.log(
      `Embedded ${Math.min(i + batchSize, splits.length)}/${splits.length} chunks of ${cacheKey}`
    );
    if (i + batchSize < splits.length) await sleep(61000);
  }
  if (splits.length >= batchSize) await sleep(61000);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      vectors: allVectors,
      docs: allDocs.map((d) => ({
        pageContent: d.pageContent,
        metadata: d.metadata,
      })),
    })
  );
  console.log(`Saved ${allDocs.length} embeddings to cache for ${cacheKey}`);
  return allDocs.length;
}
