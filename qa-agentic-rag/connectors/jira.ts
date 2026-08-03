/**
 * Live Jira Cloud connector.
 *
 * .env:
 *   JIRA_BASE_URL=https://your-site.atlassian.net
 *   JIRA_EMAIL=you@company.com
 *   JIRA_API_TOKEN=...   # https://id.atlassian.com/manage-profile/security/api-tokens
 *   JIRA_PROJECT_KEY=PROJ
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

export type JiraIssueSummary = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  issuetype: string;
  priority: string;
  assignee: string;
  updated: string;
  url: string;
  description: string;
};

export function isJiraConfigured(): boolean {
  return isAtlassianConfigured();
}

async function searchIssues(jql: string, maxResults = 50): Promise<{
  ok: boolean;
  issues: any[];
  message: string;
}> {
  if (!isJiraConfigured()) {
    return {
      ok: false,
      issues: [],
      message:
        "Jira not configured. Set JIRA_EMAIL + JIRA_API_TOKEN in .env " +
        "(https://id.atlassian.com/manage-profile/security/api-tokens). " +
        "Without a token the agent cannot see live SCRUM issues.",
    };
  }

  let res = await atlassianFetch("/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql,
      maxResults,
      fields: [
        "summary",
        "description",
        "status",
        "issuetype",
        "priority",
        "labels",
        "assignee",
        "created",
        "updated",
      ],
    }),
  });

  if (!res.ok) {
    res = await atlassianFetch(
      `/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    return {
      ok: false,
      issues: [],
      message: `Jira API error ${res.status}: ${body.slice(0, 300)}`,
    };
  }

  const data = (await res.json()) as {
    issues?: unknown[];
    values?: unknown[];
  };
  return {
    ok: true,
    issues: data.issues ?? data.values ?? [],
    message: "ok",
  };
}

function toSummary(issue: any, baseUrl: string): JiraIssueSummary {
  const f = issue.fields ?? {};
  const desc =
    typeof f.description === "string"
      ? f.description
      : adfToText(f.description);
  const key = issue.key ?? "UNKNOWN";
  return {
    key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "n/a",
    statusCategory: f.status?.statusCategory?.name ?? "",
    issuetype: f.issuetype?.name ?? "n/a",
    priority: f.priority?.name ?? "n/a",
    assignee: f.assignee?.displayName ?? "Unassigned",
    updated: f.updated ?? "",
    url: `${baseUrl}/browse/${key}`,
    description: (desc ?? "").trim(),
  };
}

/** Fetch one issue by key (e.g. SCRUM-8) via live Jira API. */
export async function fetchJiraIssueByKey(issueKey: string): Promise<{
  ok: boolean;
  issue?: JiraIssueSummary;
  markdown?: string;
  message: string;
  source: "live" | "disk" | "none";
}> {
  const key = issueKey.trim().toUpperCase();
  const { baseUrl } = getAtlassianConfig();

  if (isJiraConfigured()) {
    const res = await atlassianFetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,priority,labels,assignee,created,updated`
    );
    if (res.ok) {
      const raw = await res.json();
      const issue = toSummary(raw, baseUrl);
      const file = writeIssueDoc(issue);
      refreshJiraIndexFromDisk();
      return {
        ok: true,
        issue,
        markdown: issueToMarkdown(issue),
        message: `Fetched ${key} live from Jira (${file})`,
        source: "live",
      };
    }
    const body = await res.text();
    // Fall through to disk if API fails
    console.warn(`[jira] live fetch ${key} failed: ${res.status} ${body.slice(0, 120)}`);
  }

  // Fallback: webhook/ingest may have written the file already
  const disk = path.join(QA_DOCS_DIR, "jira", "live", `${key}.md`);
  if (fs.existsSync(disk)) {
    const markdown = fs.readFileSync(disk, "utf-8");
    return {
      ok: true,
      markdown,
      message: `Loaded ${key} from local index (qa-docs/jira/live). Live API skipped or unavailable.`,
      source: "disk",
      issue: {
        key,
        summary: markdown.match(/^#\s+[A-Z]+-\d+:\s*(.+)$/m)?.[1]?.trim() ?? key,
        status: markdown.match(/^- Status:\s*(.+)$/m)?.[1]?.trim() ?? "n/a",
        statusCategory: "",
        issuetype: markdown.match(/^- Type:\s*(.+)$/m)?.[1]?.trim() ?? "n/a",
        priority: markdown.match(/^- Priority:\s*(.+)$/m)?.[1]?.trim() ?? "n/a",
        assignee: markdown.match(/^- Assignee:\s*(.+)$/m)?.[1]?.trim() ?? "Unassigned",
        updated: markdown.match(/^- Updated:\s*(.+)$/m)?.[1]?.trim() ?? "",
        url: `${baseUrl}/browse/${key}`,
        description: markdown,
      },
    };
  }

  return {
    ok: false,
    message: isJiraConfigured()
      ? `Could not find ${key} via Jira API or local index.`
      : `Jira not configured and ${key} is not in qa-docs/jira/live/. Set JIRA_EMAIL + JIRA_API_TOKEN in .env (https://id.atlassian.com/manage-profile/security/api-tokens), or ensure the Jira webhook/ingest has synced this issue.`,
    source: "none",
  };
}

/** Live list of Jira issues (open = not Done by default). */
export async function listJiraIssues(opts?: {
  openOnly?: boolean;
  limit?: number;
}): Promise<{
  ok: boolean;
  projectKey: string;
  baseUrl: string;
  issues: JiraIssueSummary[];
  message: string;
}> {
  const { projectKey, baseUrl } = getAtlassianConfig();
  const openOnly = opts?.openOnly ?? true;
  const limit = opts?.limit ?? 50;
  if (!projectKey) {
    return {
      ok: false,
      projectKey: "",
      baseUrl,
      issues: [],
      message: "Set JIRA_PROJECT_KEY in .env to list issues.",
    };
  }
  const jql = openOnly
    ? `project = ${projectKey} AND statusCategory != Done ORDER BY updated DESC`
    : `project = ${projectKey} ORDER BY updated DESC`;

  const searched = await searchIssues(jql, limit);
  if (!searched.ok) {
    return {
      ok: false,
      projectKey,
      baseUrl,
      issues: [],
      message: searched.message,
    };
  }

  const issues = searched.issues.map((i) => toSummary(i, baseUrl));
  return {
    ok: true,
    projectKey,
    baseUrl,
    issues,
    message: `Found ${issues.length} issue(s) in ${projectKey}` +
      (openOnly ? " (open / not Done)" : ""),
  };
}

export function formatJiraIssuesMarkdown(
  projectKey: string,
  baseUrl: string,
  issues: JiraIssueSummary[],
  title = "Jira issues"
): string {
  const lines = [
    `# ${title} — ${projectKey}`,
    ``,
    `Site: ${baseUrl}`,
    `Fetched live from Jira API.`,
    `Count: ${issues.length}`,
    ``,
  ];
  for (const i of issues) {
    lines.push(`## ${i.key}: ${i.summary}`);
    lines.push(`- **Status:** ${i.status}`);
    lines.push(`- **Type:** ${i.issuetype}`);
    lines.push(`- **Priority:** ${i.priority}`);
    lines.push(`- **Assignee:** ${i.assignee}`);
    lines.push(`- **URL:** ${i.url}`);
    if (i.description) {
      lines.push(``);
      lines.push(i.description.slice(0, 800));
    }
    lines.push(``);
  }
  if (!issues.length) lines.push(`_No issues found._`);
  return lines.join("\n");
}

function liveDir(): string {
  const dir = path.join(QA_DOCS_DIR, "jira", "live");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function issueToMarkdown(issue: JiraIssueSummary): string {
  return [
    `# ${issue.key}: ${issue.summary}`,
    ``,
    `- Type: ${issue.issuetype}`,
    `- Status: ${issue.status}`,
    `- Priority: ${issue.priority}`,
    `- Assignee: ${issue.assignee}`,
    `- Updated: ${issue.updated}`,
    `- URL: ${issue.url}`,
    ``,
    `## Description`,
    issue.description || "(no description)",
    ``,
  ].join("\n");
}

/** Write/update one issue markdown under qa-docs/jira/live/. */
export function writeIssueDoc(issue: JiraIssueSummary): string {
  const file = path.join(liveDir(), `${issue.key}.md`);
  fs.writeFileSync(file, issueToMarkdown(issue));
  return file;
}

function listIssueSummariesFromDisk(): JiraIssueSummary[] {
  const { baseUrl } = getAtlassianConfig();
  const dir = liveDir();
  const issues: JiraIssueSummary[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    if (name === "INDEX.md" || name === "open-issues.md") continue;
    if (name.startsWith(".")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf-8");
    const key = name.replace(/\.md$/, "");
    const summary =
      text.match(/^#\s+[A-Z]+-\d+:\s*(.+)$/m)?.[1]?.trim() ?? key;
    const status = text.match(/^- Status:\s*(.+)$/m)?.[1]?.trim() ?? "n/a";
    const issuetype = text.match(/^- Type:\s*(.+)$/m)?.[1]?.trim() ?? "n/a";
    const priority = text.match(/^- Priority:\s*(.+)$/m)?.[1]?.trim() ?? "n/a";
    const assignee =
      text.match(/^- Assignee:\s*(.+)$/m)?.[1]?.trim() ?? "Unassigned";
    const updated = text.match(/^- Updated:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const url =
      text.match(/^- URL:\s*(.+)$/m)?.[1]?.trim() ?? `${baseUrl}/browse/${key}`;
    const done = /done|closed|resolved/i.test(status);
    issues.push({
      key,
      summary,
      status,
      statusCategory: done ? "Done" : "To Do",
      issuetype,
      priority,
      assignee,
      updated,
      url,
      description: "",
    });
  }
  return issues.sort((a, b) => a.key.localeCompare(b.key));
}

/** Rebuild INDEX.md + open-issues.md from on-disk issue files. */
export function refreshJiraIndexFromDisk(): string[] {
  const { projectKey, baseUrl } = getAtlassianConfig();
  const dir = liveDir();
  const issues = listIssueSummariesFromDisk();
  const written: string[] = [];

  const open = issues.filter((i) => i.statusCategory !== "Done");
  const openFile = path.join(dir, "open-issues.md");
  fs.writeFileSync(
    openFile,
    formatJiraIssuesMarkdown(projectKey, baseUrl, open, "Open Jira issues") +
      "\n"
  );
  written.push(openFile);

  const indexLines = [
    `# Jira live sync — ${projectKey}`,
    ``,
    `Site: ${baseUrl}`,
    `Updated: ${new Date().toISOString()}`,
    `Issues: ${issues.length}`,
    ``,
    ...issues.map(
      (i) => `- [${i.key}](${i.key}.md) — ${i.summary} (${i.status})`
    ),
    ``,
  ];
  const indexFile = path.join(dir, "INDEX.md");
  fs.writeFileSync(indexFile, indexLines.join("\n"));
  written.push(indexFile);
  return written;
}

export type JiraWebhookResult = {
  ok: boolean;
  handled: boolean;
  event: string;
  key?: string;
  action: "upserted" | "deleted" | "ignored";
  written: string[];
  message: string;
};

/**
 * Apply a Jira Cloud webhook payload to qa-docs/jira/live/.
 * Uses issue data from the webhook body (no API token required).
 */
export function applyJiraWebhookPayload(payload: any): JiraWebhookResult {
  const event = String(payload?.webhookEvent ?? payload?.issue_event_type_name ?? "");
  const issue = payload?.issue;
  const { baseUrl, projectKey } = getAtlassianConfig();

  if (!event && !issue) {
    return {
      ok: false,
      handled: false,
      event: "",
      action: "ignored",
      written: [],
      message: "Not a Jira issue webhook payload",
    };
  }

  const isDeleted =
    /issue_deleted/i.test(event) || payload?.issue_event_type_name === "issue_deleted";
  const isUpsert =
    /issue_created|issue_updated/i.test(event) ||
    ["issue_created", "issue_updated", "issue_generic"].includes(
      String(payload?.issue_event_type_name ?? "")
    );

  if (!issue?.key) {
    return {
      ok: true,
      handled: false,
      event,
      action: "ignored",
      written: [],
      message: `Ignored webhook event (no issue): ${event || "unknown"}`,
    };
  }

  const key = String(issue.key);
  // Optional: only index configured project
  if (projectKey && !key.startsWith(`${projectKey}-`)) {
    return {
      ok: true,
      handled: false,
      event,
      key,
      action: "ignored",
      written: [],
      message: `Ignored ${key} (outside project ${projectKey})`,
    };
  }

  if (isDeleted) {
    const file = path.join(liveDir(), `${key}.md`);
    const written: string[] = [];
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      written.push(file);
    }
    written.push(...refreshJiraIndexFromDisk());
    return {
      ok: true,
      handled: true,
      event,
      key,
      action: "deleted",
      written,
      message: `Deleted ${key} from vector-doc folder`,
    };
  }

  if (!isUpsert && event && !/jira:issue_/i.test(event)) {
    return {
      ok: true,
      handled: false,
      event,
      key,
      action: "ignored",
      written: [],
      message: `Ignored webhook event: ${event}`,
    };
  }

  const summary = toSummary(issue, baseUrl);
  const file = writeIssueDoc(summary);
  const written = [file, ...refreshJiraIndexFromDisk()];
  return {
    ok: true,
    handled: true,
    event: event || "issue_upsert",
    key,
    action: "upserted",
    written,
    message: `Upserted ${key} into qa-docs/jira/live/`,
  };
}

export async function syncJiraToDocs(): Promise<{
  ok: boolean;
  written: string[];
  message: string;
}> {
  const listed = await listJiraIssues({ openOnly: false, limit: 50 });
  if (!listed.ok) {
    return { ok: false, written: [], message: listed.message };
  }

  const written: string[] = [];
  for (const issue of listed.issues) {
    written.push(writeIssueDoc(issue));
  }
  written.push(...refreshJiraIndexFromDisk());

  const openCount = listed.issues.filter(
    (i) => !/done|closed|resolved/i.test(i.status)
  ).length;

  return {
    ok: true,
    written,
    message: `Synced ${listed.issues.length} Jira issue(s) from ${listed.projectKey} (${openCount} open)`,
  };
}
