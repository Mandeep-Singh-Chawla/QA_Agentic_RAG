/**
 * Case 1 — Ingestion (diagram: connectors → clean/enrich → chunk → embed → vector DB).
 *
 * Local stand-in for JIRA/GitHub/Confluence/Xray webhooks:
 * reads files from qa-docs/<source>/ and indexes them with source metadata.
 * Jira issue webhooks call processJiraWebhook() → disk upsert + reindex.
 */
import fs from "node:fs";
import path from "node:path";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import type { VectorStore } from "@langchain/core/vectorstores";
import { makeEmbeddings, addDocumentsCached } from "./lib/vectorCache";
import {
  QA_CACHE_DIR,
  QA_DOCS_DIR,
  SOURCES,
  VECTOR_BACKEND,
  type SourceName,
} from "./config";
import {
  createFreshVectorStore,
  openVectorStore,
  vectorBackendLabel,
  type QaVectorStore,
} from "./vectorStore";
import { syncGithubToDocs } from "./connectors/github";
import { syncAutomationCatalogToDocs } from "./connectors/automationCatalog";
import { syncDefectsToDocs } from "./connectors/defects";
import { syncDevChangeToDocs } from "./connectors/devChange";
import {
  applyJiraWebhookPayload,
  isJiraConfigured,
  syncJiraToDocs,
  type JiraWebhookResult,
} from "./connectors/jira";
import {
  isConfluenceConfigured,
  syncConfluenceToDocs,
} from "./connectors/confluence";
import { syncXrayToDocs } from "./connectors/xray";

const TEXT_EXTS = new Set([".md", ".markdown", ".txt"]);
const SKIP = new Set(["readme.md", ".ds_store"]);

/** Written when a Jira webhook updates docs — Studio/CLI reindex on next question. */
export const JIRA_WEBHOOK_STAMP = path.join(
  QA_DOCS_DIR,
  "jira",
  "live",
  ".webhook-updated"
);

let store: QaVectorStore | null = null;
/** Last time this process finished building / connecting the vector store. */
let lastIndexedAt = 0;

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip caches and demo/sample stubs so they don't override live APIs
      if (
        entry.name === "cache" ||
        entry.name === "sample" ||
        entry.name === "_sample"
      )
        continue;
      out.push(...listFilesRecursive(full));
      continue;
    }
    if (SKIP.has(entry.name.toLowerCase())) continue;
    if (entry.name.startsWith(".")) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === ".pdf" || TEXT_EXTS.has(ext)) out.push(full);
  }
  return out;
}

function detectSource(filePath: string): SourceName | "other" {
  const rel = path
    .relative(QA_DOCS_DIR, filePath)
    .split(path.sep)[0]
    ?.toLowerCase();
  if (SOURCES.includes(rel as SourceName)) return rel as SourceName;
  return "other";
}

async function loadFile(filePath: string, source: string): Promise<Document[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const docs = await new PDFLoader(filePath).load();
    return docs.map(
      (d) =>
        new Document({
          pageContent: d.pageContent,
          metadata: {
            ...d.metadata,
            source: filePath,
            sourceSystem: source,
            title: path.basename(filePath),
          },
        })
    );
  }
  const text = fs.readFileSync(filePath, "utf-8").trim();
  if (!text) return [];
  return [
    new Document({
      pageContent: text,
      metadata: {
        source: filePath,
        sourceSystem: source,
        title: path.basename(filePath),
      },
    }),
  ];
}

export function touchWebhookStamp(meta?: Record<string, unknown>) {
  const dir = path.dirname(JIRA_WEBHOOK_STAMP);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    JIRA_WEBHOOK_STAMP,
    JSON.stringify(
      { at: new Date().toISOString(), ...(meta ?? {}) },
      null,
      2
    ) + "\n"
  );
}

function webhookStampNewerThanIndex(): boolean {
  if (!fs.existsSync(JIRA_WEBHOOK_STAMP)) return false;
  const stampMtime = fs.statSync(JIRA_WEBHOOK_STAMP).mtimeMs;
  return stampMtime > lastIndexedAt;
}

export async function syncLiveSources(
  sources?: SourceName[]
): Promise<Record<string, string>> {
  const wanted = sources?.length ? sources : [...SOURCES];
  const messages: Record<string, string> = {};

  if (wanted.includes("github")) {
    // Public repo listing works without GITHUB_TOKEN
    const s = await syncGithubToDocs();
    messages.github = s.message;
    console.log("[github]", s.message);
    try {
      const dev = await syncDevChangeToDocs();
      messages["github:dev"] = dev.message;
      console.log("[github:dev]", dev.message);
    } catch (e) {
      messages["github:dev"] =
        e instanceof Error ? e.message : "dev change sync failed";
    }
    try {
      const catalog = await syncAutomationCatalogToDocs();
      messages["github:automation"] = catalog.message;
      console.log("[github:automation]", catalog.message);
    } catch (e) {
      messages["github:automation"] =
        e instanceof Error ? e.message : "automation catalog sync failed";
    }
  }
  if (wanted.includes("jira")) {
    if (isJiraConfigured()) {
      const s = await syncJiraToDocs();
      messages.jira = s.message;
      console.log("[jira]", s.message);
    } else {
      messages.jira = "skipped (set JIRA_EMAIL + JIRA_API_TOKEN)";
    }
    try {
      const defects = await syncDefectsToDocs();
      messages["jira:defects"] = defects.message;
      console.log("[jira:defects]", defects.message);
    } catch (e) {
      messages["jira:defects"] =
        e instanceof Error ? e.message : "defect sync failed";
    }
  }
  if (wanted.includes("confluence")) {
    if (isConfluenceConfigured()) {
      const s = await syncConfluenceToDocs();
      messages.confluence = s.message;
      console.log("[confluence]", s.message);
    } else {
      messages.confluence = "skipped (set JIRA_EMAIL + JIRA_API_TOKEN)";
    }
  }
  if (wanted.includes("xray")) {
    const s = await syncXrayToDocs();
    messages.xray = s.message;
    console.log("[xray]", s.message);
  }

  return messages;
}

/**
 * Rebuild in-memory vector store from files already on disk (no live API sync).
 * Used after Jira webhooks and when Studio detects a webhook stamp.
 */
export async function reindexFromDisk(sources?: SourceName[]): Promise<{
  files: number;
  chunks: number;
  bySource: Record<string, number>;
}> {
  const wanted = sources?.length ? sources : [...SOURCES];
  const files = listFilesRecursive(QA_DOCS_DIR).filter((f) => {
    const src = detectSource(f);
    return src === "other" ? false : wanted.includes(src);
  });

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const embeddings = makeEmbeddings();
  store = await createFreshVectorStore(embeddings);
  const bySource: Record<string, number> = {};
  let chunks = 0;

  for (const filePath of files) {
    const sourceSystem = detectSource(filePath);
    if (sourceSystem === "other") continue;
    const docs = await loadFile(filePath, sourceSystem);
    const cleaned = docs.map(
      (d) =>
        new Document({
          pageContent: d.pageContent.replace(/\r\n/g, "\n").trim(),
          metadata: d.metadata,
        })
    );
    const splits = await splitter.splitDocuments(cleaned);
    // Include file mtime so webhook-updated issue files get fresh embeddings
    const base = path.basename(filePath).replace(/\W+/g, "_");
    const mtime = Math.floor(fs.statSync(filePath).mtimeMs);
    const cacheKey = `agentic-${sourceSystem}-${base}-m${mtime}`;
    const n = await addDocumentsCached(
      store,
      embeddings,
      splits,
      cacheKey,
      90,
      QA_CACHE_DIR
    );
    bySource[sourceSystem] = (bySource[sourceSystem] ?? 0) + n;
    chunks += n;
  }

  lastIndexedAt = Date.now();
  console.log(
    `[ingest] indexed ${chunks} chunks → ${vectorBackendLabel()}`
  );
  return {
    files: files.length,
    chunks,
    bySource,
  };
}

export async function ingestAll(sources?: SourceName[]): Promise<{
  files: number;
  chunks: number;
  bySource: Record<string, number>;
  liveSync: Record<string, string>;
}> {
  const wanted = sources?.length ? sources : [...SOURCES];
  const liveSync = await syncLiveSources(wanted);
  const indexed = await reindexFromDisk(wanted);
  return { ...indexed, liveSync };
}

export function getStore(): VectorStore | null {
  return store;
}

export async function ensureIngested(): Promise<QaVectorStore> {
  const liveRepos = path.join(QA_DOCS_DIR, "github", "live", "my-repos.md");
  const webhookNewer = webhookStampNewerThanIndex();

  // Qdrant persists across restarts — reconnect without re-embedding when possible
  if (
    !store &&
    VECTOR_BACKEND === "qdrant" &&
    fs.existsSync(liveRepos) &&
    !webhookNewer
  ) {
    try {
      store = await openVectorStore(makeEmbeddings(), null);
      lastIndexedAt = Date.now();
      console.log(`[ingest] reconnected to ${vectorBackendLabel()}`);
      return store;
    } catch (e) {
      console.warn(
        "[ingest] Qdrant reconnect failed, running full ingest:",
        e instanceof Error ? e.message : e
      );
    }
  }

  const needsCold = !store || !fs.existsSync(liveRepos) || webhookNewer;

  if (needsCold) {
    if (!store || !fs.existsSync(liveRepos)) {
      await ingestAll();
    } else {
      console.log("[ingest] Jira webhook stamp newer — reindexing from disk");
      await reindexFromDisk();
    }
  }
  if (!store) throw new Error("Ingest produced an empty vector store");
  return store;
}

/** Webhook-style ingest for one source folder (diagram: connectors). */
export async function ingestSource(source: SourceName) {
  return ingestAll([source]);
}

/**
 * Jira Cloud webhook handler:
 * 1) write/update issue markdown under qa-docs/jira/live/
 * 2) touch stamp (Studio picks up on next question)
 * 3) reindex in-memory vector store in this process
 */
export async function processJiraWebhook(payload: unknown): Promise<{
  webhook: JiraWebhookResult;
  indexed?: { files: number; chunks: number; bySource: Record<string, number> };
}> {
  const webhook = applyJiraWebhookPayload(payload);
  if (!webhook.handled) {
    return { webhook };
  }

  touchWebhookStamp({
    event: webhook.event,
    key: webhook.key,
    action: webhook.action,
  });

  // Prefer full reindex so deletes remove old chunks cleanly
  const indexed = await reindexFromDisk();
  console.log(
    `[jira-webhook] ${webhook.message} → indexed ${indexed.chunks} chunks`
  );
  return { webhook, indexed };
}
