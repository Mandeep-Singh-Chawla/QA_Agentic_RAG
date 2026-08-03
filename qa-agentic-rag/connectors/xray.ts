/**
 * Live Xray connector (optional).
 *
 * Preferred (Xray Cloud API):
 *   XRAY_CLIENT_ID=...
 *   XRAY_CLIENT_SECRET=...
 *   Create keys in Jira → Apps → Xray → API Keys
 *
 * Fallback: if Xray API not configured, pull Jira issues of type "Test" / "Test Set"
 * from the same SCRUM project (works when Xray issue types exist).
 */
import fs from "node:fs";
import path from "node:path";
import { QA_DOCS_DIR } from "../config";
import {
  adfToText,
  atlassianFetch,
  getAtlassianConfig,
  isAtlassianConfigured,
} from "./atlassianAuth";

export function isXrayConfigured(): boolean {
  return Boolean(
    process.env.XRAY_CLIENT_ID?.trim() &&
      process.env.XRAY_CLIENT_SECRET?.trim()
  );
}

async function syncViaXrayCloud(): Promise<{
  ok: boolean;
  written: string[];
  message: string;
}> {
  const clientId = process.env.XRAY_CLIENT_ID!.trim();
  const clientSecret = process.env.XRAY_CLIENT_SECRET!.trim();
  const { projectKey } = getAtlassianConfig();
  const outDir = path.join(QA_DOCS_DIR, "xray", "live");
  fs.mkdirSync(outDir, { recursive: true });

  const authRes = await fetch(
    "https://xray.cloud.getxray.app/api/v2/authenticate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    }
  );
  if (!authRes.ok) {
    return {
      ok: false,
      written: [],
      message: `Xray auth failed ${authRes.status}: ${(await authRes.text()).slice(0, 200)}`,
    };
  }
  const tokenRaw = await authRes.text();
  const token = tokenRaw.replace(/^"|"$/g, "");

  const gql = `
    query {
      getTests(jql: "project = ${projectKey}", limit: 50) {
        results {
          issueId
          jira(fields: ["key", "summary", "status", "description"])
        }
      }
    }`;

  const gqlRes = await fetch("https://xray.cloud.getxray.app/api/v2/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: gql }),
  });

  if (!gqlRes.ok) {
    return {
      ok: false,
      written: [],
      message: `Xray GraphQL error ${gqlRes.status}: ${(await gqlRes.text()).slice(0, 200)}`,
    };
  }

  const data = await gqlRes.json();
  const results = data?.data?.getTests?.results ?? [];
  const written: string[] = [];

  for (const t of results) {
    const jira = t.jira ?? {};
    const key = jira.key ?? t.issueId ?? "TEST";
    const md = [
      `# Xray Test ${key}`,
      ``,
      `- Summary: ${jira.summary ?? ""}`,
      `- Status: ${typeof jira.status === "object" ? jira.status?.name : jira.status ?? ""}`,
      `- Issue ID: ${t.issueId}`,
      ``,
      `## Description`,
      typeof jira.description === "string"
        ? jira.description
        : adfToText(jira.description) || "(none)",
      ``,
    ].join("\n");
    const file = path.join(outDir, `${key}.md`);
    fs.writeFileSync(file, md);
    written.push(file);
  }

  return {
    ok: true,
    written,
    message: `Synced ${written.length} Xray test(s) via Xray Cloud API`,
  };
}

async function syncViaJiraTestIssues(): Promise<{
  ok: boolean;
  written: string[];
  message: string;
}> {
  if (!isAtlassianConfigured()) {
    return {
      ok: false,
      written: [],
      message: "Xray fallback needs JIRA_EMAIL + JIRA_API_TOKEN",
    };
  }
  const { projectKey, baseUrl } = getAtlassianConfig();
  const jql = `project = ${projectKey} AND issuetype in ("Test", "Test Set", "Test Execution", "Test Plan") ORDER BY updated DESC`;

  let res = await atlassianFetch("/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql,
      maxResults: 50,
      fields: ["summary", "description", "status", "issuetype", "labels", "updated"],
    }),
  });
  if (!res.ok) {
    res = await atlassianFetch(
      `/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=50`
    );
  }
  if (!res.ok) {
    return {
      ok: false,
      written: [],
      message:
        `No Xray API keys and Jira Test issue types not found (${res.status}). ` +
        `Add XRAY_CLIENT_ID/SECRET or keep using qa-docs/xray/ folder files.`,
    };
  }

  const data = await res.json();
  const issues = data.issues ?? data.values ?? [];
  if (!issues.length) {
    return {
      ok: false,
      written: [],
      message:
        "Xray not installed / no Test issues in project. " +
        "Optional: set XRAY_CLIENT_ID + XRAY_CLIENT_SECRET, or add markdown under qa-docs/xray/.",
    };
  }

  const outDir = path.join(QA_DOCS_DIR, "xray", "live");
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const issue of issues) {
    const key = issue.key;
    const f = issue.fields ?? {};
    const md = [
      `# ${key}: ${f.summary ?? ""}`,
      ``,
      `- Type: ${f.issuetype?.name}`,
      `- Status: ${f.status?.name}`,
      `- URL: ${baseUrl}/browse/${key}`,
      ``,
      adfToText(f.description) || "(no description)",
      ``,
    ].join("\n");
    const file = path.join(outDir, `${key}.md`);
    fs.writeFileSync(file, md);
    written.push(file);
  }

  return {
    ok: true,
    written,
    message: `Synced ${written.length} Jira Test-type issue(s) as Xray fallback`,
  };
}

export async function syncXrayToDocs() {
  if (isXrayConfigured()) return syncViaXrayCloud();
  return syncViaJiraTestIssues();
}
