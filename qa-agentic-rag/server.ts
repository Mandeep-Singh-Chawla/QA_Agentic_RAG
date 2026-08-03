/**
 * Production HTTP API for qa-agentic-rag:
 * - GET  /health          → liveness
 * - GET  /readyz          → readiness (deps)
 * - POST /webhooks/jira   → Jira Cloud webhook → upsert + reindex
 * - POST /ingest[/source] → index docs
 * - POST /sync            → pull live APIs
 * - POST /query           → guardrails → orchestrator
 */
import "./tracing";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  assertProductionConfig,
  IS_PRODUCTION,
  PKG_DIR,
  PORT,
  QDRANT_URL,
  VECTOR_BACKEND,
  type SourceName,
} from "./config";
import {
  checkApiAuth,
  checkInputGuardrails,
  checkRateLimit,
  checkWebhookSecret,
  redactDeep,
} from "./guardrails";
import {
  ensureIngested,
  ingestAll,
  ingestSource,
  processJiraWebhook,
  syncLiveSources,
} from "./ingest";
import { runOrchestrator } from "./orchestrator";
import { corsAllows, newRequestId, securityHeaders } from "./lib/httpSecurity";
import { log } from "./lib/logger";

assertProductionConfig();

const OUT_DIR = path.join(PKG_DIR, "qa-output");
let shuttingDown = false;

function clientKey(req: http.IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function send(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders?: Record<string, string | number>
) {
  const json = JSON.stringify(redactDeep(body), null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...securityHeaders(req, requestId),
    ...(extraHeaders ?? {}),
  });
  res.end(json);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  const max = Number(process.env.QA_MAX_BODY_BYTES ?? 1_000_000);
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error(`Request body too large (>${max} bytes)`);
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function requireAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  entrypoint: string,
  requestId: string
): boolean {
  const auth = checkApiAuth(req.headers as Record<string, string | string[]>, {
    entrypoint,
    client: clientKey(req),
  });
  if (!auth.ok) {
    send(req, res, 401, { ok: false, error: auth.reason, requestId }, requestId);
    return false;
  }
  return true;
}

function requireRateLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  entrypoint: string,
  requestId: string
): boolean {
  const rl = checkRateLimit(clientKey(req), { entrypoint });
  if (!rl.ok) {
    send(
      req,
      res,
      429,
      { ok: false, error: rl.reason, requestId },
      requestId,
      rl.retryAfterSec ? { "Retry-After": rl.retryAfterSec } : undefined
    );
    return false;
  }
  return true;
}

async function readiness(): Promise<{
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {
    process: { ok: !shuttingDown },
    googleApiKey: {
      ok: Boolean((process.env.GOOGLE_API_KEY ?? "").trim()),
      detail: "GOOGLE_API_KEY",
    },
  };

  if (VECTOR_BACKEND === "qdrant") {
    try {
      const r = await fetch(`${QDRANT_URL.replace(/\/$/, "")}/readyz`, {
        signal: AbortSignal.timeout(2500),
      });
      checks.qdrant = {
        ok: r.ok,
        detail: r.ok ? QDRANT_URL : `HTTP ${r.status}`,
      };
    } catch (e) {
      checks.qdrant = {
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  } else {
    checks.vector = { ok: true, detail: "memory" };
  }

  if (IS_PRODUCTION) {
    checks.apiToken = {
      ok: Boolean((process.env.QA_API_TOKEN ?? "").trim()),
    };
    checks.webhookSecret = {
      ok: Boolean((process.env.JIRA_WEBHOOK_SECRET ?? "").trim()),
    };
  }

  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

function saveMarkdown(result: Awaited<ReturnType<typeof runOrchestrator>>) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const mdPath = path.join(OUT_DIR, `agentic-${stamp}.md`);
  const a = result.answer;
  const md = [
    `# Agentic RAG QA Output`,
    ``,
    `**Intent:** ${result.intent}`,
    `**Routed to:** ${result.routedTo.join(", ")}`,
    `**Route reasoning:** ${result.routeReasoning}`,
    result.outputBlocked ? `**Output blocked:** true` : "",
    ``,
    `## Narrative`,
    a.narrative,
    ``,
    `## Key findings`,
    ...(a.keyFindings?.length ? a.keyFindings.map((x) => `- ${x}`) : ["- None"]),
    ``,
    `## Gaps`,
    ...(a.gaps?.length ? a.gaps.map((x) => `- ${x}`) : ["- None"]),
    ``,
    `## Docs used`,
    ...a.docsUsed.map((d) => `- ${d}`),
    ``,
    `## Assumptions`,
    ...a.assumptions.map((x) => `- ${x}`),
    ``,
    `## Test cases`,
    ...(a.testCases?.length
      ? a.testCases.flatMap((tc) => [
          `### ${tc.id}: ${tc.title}`,
          `- Type: ${tc.type} | Priority: ${tc.priority}`,
          tc.sourceRefs?.length ? `- Sources: ${tc.sourceRefs.join(", ")}` : "",
          ``,
          ...tc.steps.map((s, i) => `${i + 1}. ${s}`),
          ``,
          `Expected: ${tc.expectedResult}`,
          ``,
        ])
      : ["_(none for this intent)_"]),
  ]
    .filter(Boolean)
    .join("\n");
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(
    path.join(OUT_DIR, `agentic-${stamp}.json`),
    JSON.stringify(redactDeep(result), null, 2)
  );
  return mdPath;
}

const server = http.createServer(async (req, res) => {
  const requestId = newRequestId(req);
  const started = Date.now();
  try {
    if (shuttingDown) {
      return send(
        req,
        res,
        503,
        { ok: false, error: "Shutting down", requestId },
        requestId
      );
    }

    if (req.method === "OPTIONS") {
      const origin = String(req.headers.origin ?? "");
      if (origin && !corsAllows(origin)) {
        return send(
          req,
          res,
          403,
          { ok: false, error: "CORS origin not allowed", requestId },
          requestId
        );
      }
      res.writeHead(204, securityHeaders(req, requestId));
      return res.end();
    }

    const origin = String(req.headers.origin ?? "");
    if (origin && !corsAllows(origin)) {
      return send(
        req,
        res,
        403,
        { ok: false, error: "CORS origin not allowed", requestId },
        requestId
      );
    }

    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(
        req,
        res,
        200,
        {
          ok: true,
          service: "qa-agentic-rag",
          env: IS_PRODUCTION ? "production" : "development",
          webhook: "/webhooks/jira",
          guardrails: true,
          requestId,
        },
        requestId
      );
    }

    if (req.method === "GET" && url.pathname === "/readyz") {
      const ready = await readiness();
      return send(
        req,
        res,
        ready.ok ? 200 : 503,
        { ok: ready.ok, checks: ready.checks, requestId },
        requestId
      );
    }

    // Rate-limit all non-probe traffic
    if (!requireRateLimit(req, res, url.pathname, requestId)) return;

    if (
      req.method === "POST" &&
      (url.pathname === "/webhooks/jira" || url.pathname === "/webhook/jira")
    ) {
      const authHdr = String(req.headers.authorization ?? "");
      const bearer = authHdr.toLowerCase().startsWith("bearer ")
        ? authHdr.slice(7).trim()
        : "";
      const wh = checkWebhookSecret(
        {
          querySecret:
            url.searchParams.get("secret") ??
            url.searchParams.get("token") ??
            undefined,
          headerSecret: String(
            req.headers["x-webhook-secret"] ??
              req.headers["x-jira-webhook-secret"] ??
              ""
          ),
          bearer,
        },
        { client: clientKey(req) }
      );
      if (!wh.ok) {
        return send(
          req,
          res,
          401,
          { ok: false, error: wh.reason, requestId },
          requestId
        );
      }
      const payload = await readJson(req);
      const result = await processJiraWebhook(payload);
      const status = result.webhook.ok ? 200 : 400;
      log.info("webhook.jira", {
        requestId,
        ok: result.webhook.ok,
        key: result.webhook.key,
        ms: Date.now() - started,
      });
      return send(req, res, status, { ok: result.webhook.ok, ...result, requestId }, requestId);
    }

    if (req.method === "POST" && url.pathname === "/ingest") {
      if (!requireAuth(req, res, "/ingest", requestId)) return;
      const stats = await ingestAll();
      return send(req, res, 200, { ok: true, ...stats, requestId }, requestId);
    }

    const ingestMatch = url.pathname.match(
      /^\/ingest\/(confluence|jira|github|xray)$/
    );
    if (req.method === "POST" && ingestMatch) {
      if (!requireAuth(req, res, url.pathname, requestId)) return;
      const source = ingestMatch[1] as SourceName;
      // ingestSource → ingestAll already runs syncLiveSources for this source
      const stats = await ingestSource(source);
      return send(
        req,
        res,
        200,
        { ok: true, source, ...stats, requestId },
        requestId
      );
    }

    if (req.method === "POST" && url.pathname === "/sync") {
      if (!requireAuth(req, res, "/sync", requestId)) return;
      const live = await syncLiveSources();
      return send(req, res, 200, { ok: true, liveSync: live, requestId }, requestId);
    }

    if (req.method === "POST" && url.pathname === "/query") {
      if (!requireAuth(req, res, "/query", requestId)) return;
      const body = await readJson(req);
      const query = String(body.query ?? body.question ?? "").trim();
      const input = checkInputGuardrails(query, {
        entrypoint: "http:/query",
        client: clientKey(req),
      });
      if (!input.ok) {
        return send(
          req,
          res,
          400,
          {
            ok: false,
            error: input.reason,
            auditId: input.auditId,
            warnings: input.warnings,
            requestId,
          },
          requestId
        );
      }

      const store = await ensureIngested();
      const result = await runOrchestrator(store, input.sanitizedQuery);
      const saved = saveMarkdown(result);
      const status = result.outputBlocked ? 422 : 200;
      log.info("query.done", {
        requestId,
        intent: result.intent,
        blocked: Boolean(result.outputBlocked),
        ms: Date.now() - started,
      });
      return send(
        req,
        res,
        status,
        { ok: !result.outputBlocked, saved, ...result, requestId },
        requestId
      );
    }

    send(
      req,
      res,
      404,
      {
        ok: false,
        error: "Not found",
        requestId,
        endpoints: [
          "GET /health",
          "GET /readyz",
          "POST /webhooks/jira",
          "POST /sync",
          "POST /ingest",
          "POST /ingest/:source",
          "POST /query",
        ],
      },
      requestId
    );
  } catch (err: any) {
    log.error("request.failed", {
      requestId,
      error: err?.message ?? String(err),
      ms: Date.now() - started,
    });
    send(
      req,
      res,
      500,
      { ok: false, error: err?.message ?? String(err), requestId },
      requestId
    );
  }
});

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown.start", { signal });
  server.close((err) => {
    if (err) {
      log.error("shutdown.error", { error: err.message });
      process.exit(1);
    }
    log.info("shutdown.complete");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, () => {
  log.info("server.listen", {
    port: PORT,
    env: IS_PRODUCTION ? "production" : "development",
    vector: VECTOR_BACKEND,
  });
  console.log(`qa-agentic-rag listening on http://localhost:${PORT}`);
  console.log(
    `Probes: GET /health | GET /readyz | API: /query /ingest /sync /webhooks/jira`
  );
});
