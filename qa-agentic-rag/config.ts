import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (this folder). */
export const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

/** production | development (QA_ENV wins, else NODE_ENV). */
export const QA_ENV = (
  process.env.QA_ENV?.trim() ||
  process.env.NODE_ENV?.trim() ||
  "development"
).toLowerCase();

export const IS_PRODUCTION =
  QA_ENV === "production" || process.env.NODE_ENV === "production";

/** Comma-separated browser origins allowed for CORS (no * in production). */
export const CORS_ORIGINS: string[] = (
  process.env.QA_CORS_ORIGINS?.trim() ||
  (IS_PRODUCTION ? "" : "*")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Fail fast when running as production without required secrets/backends.
 * Call once at process boot (server / cli).
 */
export function assertProductionConfig(): void {
  if (!IS_PRODUCTION) return;

  const missing: string[] = [];
  if (!(process.env.QA_API_TOKEN ?? "").trim()) missing.push("QA_API_TOKEN");
  if (!(process.env.JIRA_WEBHOOK_SECRET ?? "").trim())
    missing.push("JIRA_WEBHOOK_SECRET");
  if (!(process.env.GOOGLE_API_KEY ?? "").trim()) missing.push("GOOGLE_API_KEY");
  if (
    (process.env.QA_ALLOW_INSECURE_WEBHOOK ?? "").toLowerCase() === "true"
  ) {
    missing.push("QA_ALLOW_INSECURE_WEBHOOK must be false in production");
  }
  const backend = (process.env.VECTOR_BACKEND ?? "memory").toLowerCase();
  if (backend !== "qdrant") {
    missing.push("VECTOR_BACKEND=qdrant (required in production)");
  }
  if (CORS_ORIGINS.includes("*") || CORS_ORIGINS.length === 0) {
    missing.push("QA_CORS_ORIGINS (explicit allowlist, no *)");
  }
  if (missing.length) {
    throw new Error(
      `[prod-config] Refusing to start in production. Fix: ${missing.join("; ")}`
    );
  }
}

/**
 * Docs folder: prefer `qa-agentic-rag/qa-docs` (standalone repo),
 * else parent `qa-docs` (monorepo layout).
 */
function resolveQaDocsDir(): string {
  const local = path.join(PKG_DIR, "qa-docs");
  const parent = path.resolve(PKG_DIR, "..", "qa-docs");
  if (fs.existsSync(local)) return local;
  if (fs.existsSync(parent)) return parent;
  return local;
}

export const SOURCES = ["confluence", "jira", "github", "xray"] as const;
export type SourceName = (typeof SOURCES)[number];

export const QA_DOCS_DIR = resolveQaDocsDir();
export const QA_CACHE_DIR = path.join(QA_DOCS_DIR, "cache") + path.sep;
export const PORT = Number(process.env.QA_AGENTIC_PORT ?? 8787);

/**
 * Free-tier safe defaults:
 * - gemini-3.5-flash often hits 20 req/day → use gemini-3-flash-preview
 * - lite model for routing / small tasks
 * Override with QA_CHAT_MODEL / QA_LITE_MODEL in .env
 */
export const CHAT_MODEL =
  process.env.QA_CHAT_MODEL?.trim() ||
  "google-genai:gemini-3-flash-preview";

export const LITE_MODEL =
  process.env.QA_LITE_MODEL?.trim() ||
  "google-genai:gemini-3.5-flash-lite";

/** Rerank model id for ChatGoogleGenerativeAI (no google-genai: prefix). */
export const RERANK_MODEL =
  process.env.QA_RERANK_MODEL?.trim() || "gemini-3.5-flash-lite";

/** Set QA_RERANK=true to enable LLM rerank (uses extra quota). */
export const RERANK_ENABLED =
  (process.env.QA_RERANK ?? "false").toLowerCase() === "true";

/**
 * Set QA_SOURCE_LLM=true to let each source agent call the LLM.
 * Default false = return retrieved chunks only (saves ~1 call per source).
 */
export const SOURCE_LLM_ENABLED =
  (process.env.QA_SOURCE_LLM ?? "false").toLowerCase() === "true";

/** Max sources to fan-out to (free-tier friendly). */
export const MAX_SOURCES = Number(process.env.QA_MAX_SOURCES ?? 2);

/** Dev application repo used for change-impact / risk-based test selection. */
export const DEV_REPO = process.env.DEV_REPO?.trim() || "";

/** Automation repos (owner/name) used as the regression candidate pool. */
export const AUTOMATION_REPOS: string[] = (process.env.AUTOMATION_REPOS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Vector DB backend:
 * - memory  → in-process (default, no infra)
 * - qdrant  → free local Docker or Qdrant Cloud free tier
 */
export const VECTOR_BACKEND = (
  process.env.VECTOR_BACKEND?.trim() || "memory"
).toLowerCase() as "memory" | "qdrant";

export const QDRANT_URL =
  process.env.QDRANT_URL?.trim() || "http://127.0.0.1:6333";
export const QDRANT_API_KEY = process.env.QDRANT_API_KEY?.trim() || undefined;
export const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION?.trim() || "qa_agentic";
/** gemini-embedding-001 default output size */
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 3072);
