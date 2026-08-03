/**
 * Production-oriented input/output guardrails for qa-agentic-rag.
 *
 * Covers: injection blocking, QA intent allowlist, PII/secret redaction,
 * grounding hard-fail, in-memory rate limits, API auth helpers, audit log.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { IS_PRODUCTION, PKG_DIR } from "./config";

const AUDIT_DIR = path.join(PKG_DIR, "qa-output", "audit");
const AUDIT_FILE = path.join(AUDIT_DIR, "guardrails.jsonl");

/** When true (default), RAG answers with no sources are blocked. */
export const REQUIRE_GROUNDING =
  (process.env.QA_REQUIRE_GROUNDING ?? "true").toLowerCase() !== "false";

/**
 * Require Bearer QA_API_TOKEN on mutating HTTP routes when:
 * - QA_REQUIRE_AUTH=true, or
 * - QA_ENV=production, or
 * - QA_API_TOKEN is set (token present ⇒ enforce it)
 */
export const REQUIRE_API_AUTH =
  (process.env.QA_REQUIRE_AUTH ?? "").toLowerCase() === "true" ||
  IS_PRODUCTION;

/** Allow insecure webhooks only when explicitly opted in. */
export const ALLOW_INSECURE_WEBHOOK =
  (process.env.QA_ALLOW_INSECURE_WEBHOOK ?? "false").toLowerCase() === "true";

const RATE_LIMIT_WINDOW_MS = Number(process.env.QA_RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.QA_RATE_LIMIT_MAX ?? 60);

// --- Patterns ----------------------------------------------------------------

const BLOCKED_INPUT = [
  /ignore (all )?(previous|prior|above) (instructions?|prompts?)/i,
  /\bjailbreak\b/i,
  /<\s*script\b/i,
  /\bsystem\s*prompt\b/i,
  /\bdo\s+not\s+follow\b.*\b(rules?|instructions?)\b/i,
  /\bdeveloper\s*mode\b/i,
  /\bDAN\b.*\bGPT\b/i,
  /\bexfiltrat(e|ion)\b/i,
  /\bprompt\s*injection\b/i,
  /```\s*system\b/i,
  /\boverride\b.*\b(safety|guardrail)/i,
];

/** Off-topic / clearly non-QA asks (allowlist complement). */
const OFF_TOPIC = [
  /\b(write|compose)\b.*\b(poem|song|rap|love letter)\b/i,
  /\b(hack|ddos|ransomware|malware|exploit)\b.*\b(prod|production|server)\b/i,
  /\bhow to make\b.*\b(bomb|weapon|explosive)\b/i,
];

/**
 * QA-domain allowlist — query must match at least one unless it is a short
 * follow-up that still looks operational (issue key, PR url, etc.).
 */
const QA_ALLOW = [
  /\b(test\s*cases?|scenarios?|qa|quality|regression|smoke|e2e|uat)\b/i,
  /\b(jira|confluence|xray|backlog|story|bug|defect|ticket|scrum-\d+)\b/i,
  /\b(coverage|gap|risk|optimize|impact)\b/i,
  /\b(github|repo|pr\b|pull\s*request|diff|commit|automation)\b/i,
  /\b(api|contract|endpoint|status\s*code|acceptance|requirement)\b/i,
  /\b(login|auth|selenium|restassured|appium|deepeval)\b/i,
  /\b(ingest|sync|webhook|vector|qdrant|retriev)\b/i,
  /\b[A-Z][A-Z0-9]+-\d+\b/,
  /github\.com\/[^\s]+/i,
];

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "generic_api_key",
    re: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|ATATT[A-Za-z0-9=_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: "private_key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}/gi,
  },
];

const PII_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "email",
    re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    // Rough phone — US/IN-ish; redact only clear digit runs with separators
    name: "phone",
    re: /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
  },
  {
    name: "ssn_like",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: "credit_card",
    re: /\b(?:\d[ -]*?){13,19}\b/g,
  },
];

const INTENTS_REQUIRING_GROUNDING = new Set([
  "generate_test_cases",
  "explain_requirements",
  "find_coverage_gaps",
  "api_contract_check",
]);

// --- Types -------------------------------------------------------------------

export type GuardrailAuditEvent = {
  id: string;
  at: string;
  stage: "input" | "output" | "auth" | "rate_limit" | "webhook";
  action: "allow" | "block" | "warn" | "redact";
  reason: string;
  entrypoint?: string;
  client?: string;
  meta?: Record<string, unknown>;
};

export type InputGuardResult = {
  ok: boolean;
  reason?: string;
  warnings: string[];
  sanitizedQuery: string;
  auditId: string;
};

export type OutputGuardResult = {
  ok: boolean;
  blocked: boolean;
  warnings: string[];
  sanitizedAnswer: string;
  sanitizedSources: string[];
  auditId: string;
};

// --- Audit -------------------------------------------------------------------

export function writeAudit(event: Omit<GuardrailAuditEvent, "id" | "at"> & {
  id?: string;
  at?: string;
}): GuardrailAuditEvent {
  const full: GuardrailAuditEvent = {
    id: event.id ?? crypto.randomUUID(),
    at: event.at ?? new Date().toISOString(),
    ...event,
  };
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(full) + "\n");
  } catch (e) {
    console.warn("[guardrails-audit] write failed:", e);
  }
  const line = `[guardrail:${full.stage}] ${full.action} — ${full.reason}`;
  if (full.action === "block") console.warn(line);
  else console.log(line);
  return full;
}

// --- Redaction ---------------------------------------------------------------

export function redactSecretsAndPii(text: string): {
  text: string;
  redactions: string[];
} {
  if (!text) return { text: "", redactions: [] };
  let out = text;
  const redactions: string[] = [];

  for (const { name, re } of SECRET_PATTERNS) {
    const copy = new RegExp(re.source, re.flags);
    if (copy.test(out)) {
      redactions.push(name);
      out = out.replace(new RegExp(re.source, re.flags), `[REDACTED:${name}]`);
    }
  }
  for (const { name, re } of PII_PATTERNS) {
    // Skip credit_card on short digit strings that look like issue ids / ports
    if (name === "credit_card") {
      out = out.replace(new RegExp(re.source, re.flags), (m) => {
        const digits = m.replace(/\D/g, "");
        if (digits.length < 13 || digits.length > 19) return m;
        redactions.push(name);
        return `[REDACTED:${name}]`;
      });
      continue;
    }
    const copy = new RegExp(re.source, re.flags);
    if (copy.test(out)) {
      redactions.push(name);
      out = out.replace(new RegExp(re.source, re.flags), `[REDACTED:${name}]`);
    }
  }
  return { text: out, redactions: [...new Set(redactions)] };
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecretsAndPii(value).text as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}

// --- Input -------------------------------------------------------------------

function looksLikeQaDomain(query: string): boolean {
  if (QA_ALLOW.some((re) => re.test(query))) return true;
  // Short operational follow-ups e.g. "SCRUM-9" or "PR 123"
  if (/^\s*[A-Z][A-Z0-9]+-\d+\s*$/i.test(query)) return true;
  if (/^\s*pr\s*#?\s*\d+\s*$/i.test(query)) return true;
  return false;
}

export function checkInputGuardrails(
  query: string,
  opts?: { entrypoint?: string; client?: string }
): InputGuardResult {
  const warnings: string[] = [];
  const text = (query ?? "").trim();
  const auditBase = {
    stage: "input" as const,
    entrypoint: opts?.entrypoint,
    client: opts?.client,
  };

  if (!text) {
    const a = writeAudit({
      ...auditBase,
      action: "block",
      reason: "Empty query",
    });
    return {
      ok: false,
      reason: "Empty query",
      warnings,
      sanitizedQuery: "",
      auditId: a.id,
    };
  }
  if (text.length > 8000) {
    const a = writeAudit({
      ...auditBase,
      action: "block",
      reason: "Query too long (>8000 chars)",
      meta: { length: text.length },
    });
    return {
      ok: false,
      reason: "Query too long",
      warnings,
      sanitizedQuery: text.slice(0, 200),
      auditId: a.id,
    };
  }

  for (const re of BLOCKED_INPUT) {
    if (re.test(text)) {
      const a = writeAudit({
        ...auditBase,
        action: "block",
        reason: `Blocked injection/jailbreak pattern: ${re}`,
      });
      return {
        ok: false,
        reason: "Blocked by input guardrail (prompt injection / jailbreak pattern)",
        warnings,
        sanitizedQuery: "",
        auditId: a.id,
      };
    }
  }

  for (const re of OFF_TOPIC) {
    if (re.test(text)) {
      const a = writeAudit({
        ...auditBase,
        action: "block",
        reason: `Blocked off-topic / unsafe request: ${re}`,
      });
      return {
        ok: false,
        reason:
          "Blocked by input guardrail (outside QA domain or unsafe request)",
        warnings,
        sanitizedQuery: "",
        auditId: a.id,
      };
    }
  }

  if (!looksLikeQaDomain(text)) {
    const a = writeAudit({
      ...auditBase,
      action: "block",
      reason: "Query failed QA intent allowlist",
    });
    return {
      ok: false,
      reason:
        "Blocked: query is outside the enterprise QA allowlist (tests, Jira, coverage, GitHub, requirements, APIs).",
      warnings,
      sanitizedQuery: "",
      auditId: a.id,
    };
  }

  const { text: sanitized, redactions } = redactSecretsAndPii(text);
  if (redactions.length) {
    warnings.push(`Redacted from query: ${redactions.join(", ")}`);
    writeAudit({
      ...auditBase,
      action: "redact",
      reason: `Input redaction: ${redactions.join(", ")}`,
    });
  }

  const a = writeAudit({
    ...auditBase,
    action: "allow",
    reason: "Input passed guardrails",
    meta: { warnings },
  });

  return {
    ok: true,
    warnings,
    sanitizedQuery: sanitized,
    auditId: a.id,
  };
}

// --- Output ------------------------------------------------------------------

export function checkOutputGuardrails(
  answer: string,
  sources: string[],
  opts?: {
    intent?: string;
    requireGrounding?: boolean;
    /** When set, generate_test_cases only hard-requires sources if cases were produced */
    testCaseCount?: number;
    entrypoint?: string;
  }
): OutputGuardResult {
  const warnings: string[] = [];
  const intent = opts?.intent ?? "";
  let needGround =
    opts?.requireGrounding ??
    (REQUIRE_GROUNDING && INTENTS_REQUIRING_GROUNDING.has(intent));
  // Guidance / error narratives without generated cases should not hard-fail
  if (
    intent === "generate_test_cases" &&
    (opts?.testCaseCount ?? 0) === 0 &&
    opts?.requireGrounding !== true
  ) {
    needGround = false;
  }

  const { text: sanitizedAnswer, redactions: ansRedactions } =
    redactSecretsAndPii(answer ?? "");
  const sanitizedSources = (sources ?? []).map(
    (s) => redactSecretsAndPii(s).text
  );
  if (ansRedactions.length) {
    warnings.push(`Redacted from answer: ${ansRedactions.join(", ")}`);
  }

  if (!sanitizedAnswer.trim()) {
    const a = writeAudit({
      stage: "output",
      action: "block",
      reason: "Empty model answer",
      entrypoint: opts?.entrypoint,
      meta: { intent },
    });
    return {
      ok: false,
      blocked: true,
      warnings: [...warnings, "Empty model answer"],
      sanitizedAnswer:
        "I could not produce a grounded answer. Please refine your question or check source sync.",
      sanitizedSources,
      auditId: a.id,
    };
  }

  if (needGround && sanitizedSources.filter(Boolean).length === 0) {
    const a = writeAudit({
      stage: "output",
      action: "block",
      reason: "Ungrounded answer (no sources) for grounding-required intent",
      entrypoint: opts?.entrypoint,
      meta: { intent },
    });
    return {
      ok: false,
      blocked: true,
      warnings: [
        ...warnings,
        "No sources retrieved — answer blocked (grounding required)",
      ],
      sanitizedAnswer:
        "Blocked: this answer would be ungrounded (no retrieved/live sources). " +
        "Sync Jira/docs or ask with a specific issue key / PR, then retry.",
      sanitizedSources,
      auditId: a.id,
    };
  }

  if (!needGround && sanitizedSources.length === 0) {
    warnings.push("No sources retrieved — answer may be ungrounded");
  }
  if (/as an ai language model/i.test(sanitizedAnswer)) {
    warnings.push("Generic LLM disclaimer detected");
  }

  const a = writeAudit({
    stage: "output",
    action: warnings.length ? "warn" : "allow",
    reason: warnings.length
      ? `Output warnings: ${warnings.join("; ")}`
      : "Output passed guardrails",
    entrypoint: opts?.entrypoint,
    meta: { intent, warningCount: warnings.length },
  });

  return {
    ok: true,
    blocked: false,
    warnings,
    sanitizedAnswer,
    sanitizedSources,
    auditId: a.id,
  };
}

/** Apply output guards + deep redaction to an orchestrator-shaped answer. */
export function guardOrchestratorAnswer<
  T extends {
    intent: string;
    answer: {
      narrative: string;
      docsUsed: string[];
      assumptions: string[];
      keyFindings: string[];
      gaps: string[];
      testCases: unknown[];
      suggestedAutomationCandidates: string[];
    };
    outputWarnings: string[];
  },
>(result: T, opts?: { entrypoint?: string }): T & {
  outputBlocked: boolean;
  guardrailAuditId: string;
} {
  const out = checkOutputGuardrails(result.answer.narrative, result.answer.docsUsed, {
    intent: result.intent,
    testCaseCount: result.answer.testCases?.length ?? 0,
    entrypoint: opts?.entrypoint,
  });

  const answer = redactDeep({
    ...result.answer,
    narrative: out.sanitizedAnswer,
    docsUsed: out.sanitizedSources,
  });

  if (out.blocked) {
    answer.testCases = [];
    answer.suggestedAutomationCandidates = [];
    answer.keyFindings = [];
    answer.assumptions = [];
    if (!answer.gaps?.length) {
      answer.gaps = ["Output blocked by grounding/empty guardrail"];
    }
  }

  return {
    ...result,
    answer,
    outputWarnings: [...(result.outputWarnings ?? []), ...out.warnings],
    outputBlocked: out.blocked,
    guardrailAuditId: out.auditId,
  };
}

// --- HTTP auth / rate limit / webhook ----------------------------------------

export function getConfiguredApiToken(): string {
  return (process.env.QA_API_TOKEN ?? "").trim();
}

export function checkApiAuth(
  reqHeaders: Record<string, string | string[] | undefined>,
  opts?: { entrypoint?: string; client?: string }
): { ok: boolean; reason?: string } {
  const expected = getConfiguredApiToken();
  const enforce = REQUIRE_API_AUTH || Boolean(expected);
  if (!enforce) {
    return { ok: true };
  }
  if (!expected) {
    const a = writeAudit({
      stage: "auth",
      action: "block",
      reason: "Auth required (QA_ENV=production / QA_REQUIRE_AUTH) but QA_API_TOKEN unset",
      entrypoint: opts?.entrypoint,
      client: opts?.client,
    });
    return {
      ok: false,
      reason: `API auth required but QA_API_TOKEN is unset (audit=${a.id}). Set QA_API_TOKEN.`,
    };
  }
  const auth = String(reqHeaders["authorization"] ?? "");
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  const headerToken = String(reqHeaders["x-api-key"] ?? "").trim();
  if (bearer === expected || headerToken === expected) {
    writeAudit({
      stage: "auth",
      action: "allow",
      reason: "API token accepted",
      entrypoint: opts?.entrypoint,
      client: opts?.client,
    });
    return { ok: true };
  }
  writeAudit({
    stage: "auth",
    action: "block",
    reason: "Missing/invalid API token",
    entrypoint: opts?.entrypoint,
    client: opts?.client,
  });
  return {
    ok: false,
    reason: "Unauthorized — provide Authorization: Bearer <QA_API_TOKEN>",
  };
}

export function checkWebhookSecret(
  provided: { querySecret?: string; headerSecret?: string; bearer?: string },
  opts?: { client?: string }
): { ok: boolean; reason?: string } {
  const secret = (process.env.JIRA_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    if (ALLOW_INSECURE_WEBHOOK) {
      writeAudit({
        stage: "webhook",
        action: "warn",
        reason: "Webhook accepted without secret (QA_ALLOW_INSECURE_WEBHOOK=true)",
        client: opts?.client,
      });
      return { ok: true };
    }
    writeAudit({
      stage: "webhook",
      action: "block",
      reason: "JIRA_WEBHOOK_SECRET not configured",
      client: opts?.client,
    });
    return {
      ok: false,
      reason:
        "JIRA_WEBHOOK_SECRET is required. Set it in .env, or QA_ALLOW_INSECURE_WEBHOOK=true for local-only.",
    };
  }
  const ok =
    provided.querySecret === secret ||
    provided.headerSecret === secret ||
    provided.bearer === secret;
  writeAudit({
    stage: "webhook",
    action: ok ? "allow" : "block",
    reason: ok ? "Webhook secret valid" : "Invalid webhook secret",
    client: opts?.client,
  });
  return ok
    ? { ok: true }
    : { ok: false, reason: "Invalid webhook secret" };
}

type RateBucket = { resetAt: number; count: number };
const rateBuckets = new Map<string, RateBucket>();

export function checkRateLimit(
  clientKey: string,
  opts?: { entrypoint?: string }
): { ok: boolean; reason?: string; retryAfterSec?: number } {
  const now = Date.now();
  let bucket = rateBuckets.get(clientKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 0 };
    rateBuckets.set(clientKey, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    writeAudit({
      stage: "rate_limit",
      action: "block",
      reason: `Rate limit exceeded (${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW_MS}ms)`,
      entrypoint: opts?.entrypoint,
      client: clientKey,
      meta: { count: bucket.count, retryAfterSec },
    });
    return {
      ok: false,
      reason: `Rate limit exceeded. Retry after ${retryAfterSec}s.`,
      retryAfterSec,
    };
  }
  return { ok: true };
}

/** Studio/tool helper: validate a user-facing string before tool work. */
export function guardToolInput(
  text: string,
  entrypoint: string
): InputGuardResult {
  return checkInputGuardrails(text, { entrypoint: `studio:${entrypoint}` });
}
