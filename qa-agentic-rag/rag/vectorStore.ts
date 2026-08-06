/**
 * Vector store factory — memory (default) or Qdrant (free local/cloud).
 *
 * Qdrant free options:
 * - Local:  docker run -p 6333:6333 qdrant/qdrant
 * - Cloud:  https://cloud.qdrant.io (free tier) → set QDRANT_URL + QDRANT_API_KEY
 */
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import type { Embeddings } from "@langchain/core/embeddings";
import type { VectorStore } from "@langchain/core/vectorstores";
import {
  EMBEDDING_DIM,
  QDRANT_API_KEY,
  QDRANT_COLLECTION,
  QDRANT_URL,
  VECTOR_BACKEND,
} from "../core/config";

export type QaVectorStore = VectorStore;

function qdrantClient(): QdrantClient {
  return new QdrantClient({
    url: QDRANT_URL,
    ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
    // Avoid undici "invalid onError method" crashes on some Node versions
    checkCompatibility: false,
  });
}

/** Drop collection so a full reindex starts clean. */
async function resetQdrantCollection(): Promise<void> {
  const client = qdrantClient();
  try {
    const existsRes = await client.collectionExists(QDRANT_COLLECTION);
    const exists =
      typeof existsRes === "boolean"
        ? existsRes
        : Boolean((existsRes as { exists?: boolean })?.exists);
    if (exists) {
      await client.deleteCollection(QDRANT_COLLECTION);
      console.log(`[qdrant] deleted collection ${QDRANT_COLLECTION}`);
    }
  } catch (e) {
    console.warn(
      "[qdrant] reset collection:",
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Create a fresh vector store for (re)indexing.
 * memory: new empty store
 * qdrant: reset collection then open store
 */
export async function createFreshVectorStore(
  embeddings: Embeddings
): Promise<QaVectorStore> {
  if (VECTOR_BACKEND === "qdrant") {
    await resetQdrantCollection();
    const store = new QdrantVectorStore(embeddings, {
      client: qdrantClient(),
      collectionName: QDRANT_COLLECTION,
      collectionConfig: {
        vectors: {
          size: EMBEDDING_DIM,
          distance: "Cosine",
        },
      },
    });
    console.log(
      `[qdrant] using ${QDRANT_URL} collection=${QDRANT_COLLECTION} dim=${EMBEDDING_DIM}`
    );
    return store;
  }

  console.log("[vector] using in-memory MemoryVectorStore");
  return new MemoryVectorStore(embeddings);
}

/**
 * Open existing store for query (no wipe).
 * Qdrant: connect to existing collection; memory: must already be in process.
 */
export async function openVectorStore(
  embeddings: Embeddings,
  existingMemory?: QaVectorStore | null
): Promise<QaVectorStore> {
  if (VECTOR_BACKEND === "qdrant") {
    return QdrantVectorStore.fromExistingCollection(embeddings, {
      client: qdrantClient(),
      collectionName: QDRANT_COLLECTION,
    });
  }
  if (existingMemory) return existingMemory;
  return new MemoryVectorStore(embeddings);
}

export function vectorBackendLabel(): string {
  if (VECTOR_BACKEND === "qdrant") {
    return `qdrant:${QDRANT_COLLECTION}@${QDRANT_URL}`;
  }
  return "memory";
}
