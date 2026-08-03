import type http from "node:http";
import crypto from "node:crypto";
import { CORS_ORIGINS, IS_PRODUCTION } from "../config";

export function newRequestId(req: http.IncomingMessage): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.trim()) return incoming.trim();
  return crypto.randomUUID();
}

export function securityHeaders(
  req: http.IncomingMessage,
  requestId: string
): Record<string, string> {
  const origin = String(req.headers.origin ?? "");
  const allowOrigin = resolveCorsOrigin(origin);
  const headers: Record<string, string> = {
    "X-Request-Id": requestId,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  };
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    headers["Access-Control-Allow-Headers"] =
      "Content-Type, Authorization, X-Api-Key, X-Request-Id, X-Webhook-Secret, X-Jira-Webhook-Secret";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

function resolveCorsOrigin(origin: string): string | null {
  if (!origin) {
    // Non-browser clients
    return IS_PRODUCTION ? null : "*";
  }
  if (CORS_ORIGINS.includes("*") && !IS_PRODUCTION) return origin;
  if (CORS_ORIGINS.includes(origin)) return origin;
  return null;
}

export function corsAllows(origin: string | undefined): boolean {
  if (!origin) return true;
  if (!IS_PRODUCTION && CORS_ORIGINS.includes("*")) return true;
  return CORS_ORIGINS.includes(origin);
}
