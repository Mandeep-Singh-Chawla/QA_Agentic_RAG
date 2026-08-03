/**
 * Historic production / escaped defect history for risk-optimized coverage.
 * Sources:
 *  1) Live Jira Bugs (when JIRA_API_TOKEN set)
 *  2) Local markdown under qa-docs/jira/defects/
 */
import fs from "node:fs";
import path from "node:path";
import { QA_DOCS_DIR } from "../config";
import {
  isJiraConfigured,
  listJiraIssues,
  type JiraIssueSummary,
} from "./jira";
import { atlassianFetch, getAtlassianConfig } from "./atlassianAuth";

export type HistoricDefect = {
  key: string;
  summary: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  status: string;
  areas: string[];
  source: "jira" | "local";
  url?: string;
  description?: string;
};

const AREA_KEYWORDS: { area: string; re: RegExp }[] = [
  { area: "auth", re: /\b(auth|login|lockout|session|oauth|jwt|password)\b/i },
  { area: "security", re: /\b(security|pii|guard|jailbreak|xss|injection|compliance)\b/i },
  { area: "api", re: /\b(api|rest|http|endpoint|status\s*code|423|500)\b/i },
  { area: "llm-evaluation", re: /\b(eval|metric|scorer|deepeval|hallucin)/i },
  { area: "test-data", re: /\b(dataset|prompt|golden|fixture|truncat)/i },
  { area: "ui", re: /\b(ui|frontend|screen|blank\s*screen|ux)\b/i },
  { area: "mobile", re: /\b(mobile|android|ios|appium)\b/i },
  { area: "checkout", re: /\b(checkout|cart|coupon|payment)\b/i },
  { area: "payment", re: /\b(payment|upi|card|revenue)\b/i },
  { area: "docs", re: /\b(docs?|citation|readme|metadata|version\s*bump)\b/i },
  { area: "guard", re: /\b(guardrail|guard|pii)\b/i },
  { area: "login", re: /\b(login|lockout|account\s*lock)/i },
  { area: "metric", re: /\b(metric|nan|score)\b/i },
  { area: "dataset", re: /\b(dataset|golden|label)\b/i },
];

function severityFromPriority(priority: string): HistoricDefect["severity"] {
  const p = priority.toLowerCase();
  if (/highest|blocker|critical/.test(p)) return "Critical";
  if (/high/.test(p)) return "High";
  if (/low|trivial|minor/.test(p)) return "Low";
  return "Medium";
}

function severityFromText(text: string): HistoricDefect["severity"] {
  if (/severity:\s*critical|\bseverity\b/i.test(text)) return "Critical";
  if (/severity:\s*high|\bhigh\b/i.test(text) && /severity/i.test(text))
    return "High";
  if (/severity:\s*low/i.test(text)) return "Low";
  if (/severity:\s*medium/i.test(text)) return "Medium";
  return "Medium";
}

export function inferAreas(text: string): string[] {
  const areas = new Set<string>();
  // Explicit "Areas: a, b" line
  const explicit = text.match(/areas?:\s*(.+)$/im);
  if (explicit) {
    for (const part of explicit[1].split(/[,/|]/)) {
      const a = part.trim().toLowerCase();
      if (a) areas.add(a);
    }
  }
  for (const { area, re } of AREA_KEYWORDS) {
    if (re.test(text)) areas.add(area);
  }
  if (!areas.size) areas.add("regression-smoke");
  return [...areas];
}

function parseLocalDefectMarkdown(text: string, file: string): HistoricDefect[] {
  const chunks = text.split(/^##\s+/m).slice(1);
  const out: HistoricDefect[] = [];
  for (const chunk of chunks) {
    const lines = chunk.trim().split("\n");
    const header = lines[0] ?? "";
    const keyMatch = header.match(/^([A-Z]+-\d+)/);
    const key = keyMatch?.[1] ?? `LOCAL-${out.length + 1}`;
    const summary = header.replace(/^[A-Z]+-\d+:\s*/, "").trim() || header;
    const body = lines.join("\n");
    out.push({
      key,
      summary,
      severity: severityFromText(body),
      status: body.match(/status:\s*(.+)$/im)?.[1]?.trim() ?? "Unknown",
      areas: inferAreas(`${header}\n${body}`),
      source: "local",
      url: `file://${file}`,
      description: body.slice(0, 1500),
    });
  }
  return out;
}

function loadLocalDefects(): HistoricDefect[] {
  const dir = path.join(QA_DOCS_DIR, "jira", "defects");
  if (!fs.existsSync(dir)) return [];
  const defects: HistoricDefect[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, "utf-8");
    defects.push(...parseLocalDefectMarkdown(text, file));
  }
  return defects;
}

async function fetchJiraBugs(maxResults = 50): Promise<HistoricDefect[]> {
  if (!isJiraConfigured()) return [];
  const { projectKey, baseUrl } = getAtlassianConfig();
  // Prefer Bug issue type; fall back to all issues with "bug"/"defect"/"prod" in text
  let res = await atlassianFetch("/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql: `project = ${projectKey} AND issuetype = Bug ORDER BY priority DESC, updated DESC`,
      maxResults,
      fields: [
        "summary",
        "description",
        "status",
        "issuetype",
        "priority",
        "labels",
        "updated",
      ],
    }),
  });
  if (!res.ok) {
    // Fall back to generic list and filter
    const listed = await listJiraIssues({ openOnly: false, limit: maxResults });
    return listed.issues
      .filter((i) => /bug|defect|incident/i.test(i.issuetype + i.summary))
      .map((i) => jiraToDefect(i));
  }
  const data = await res.json();
  const issues = data.issues ?? [];
  return issues.map((raw: any) => {
    const f = raw.fields ?? {};
    const summary: JiraIssueSummary = {
      key: raw.key,
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      statusCategory: f.status?.statusCategory?.name ?? "",
      issuetype: f.issuetype?.name ?? "Bug",
      priority: f.priority?.name ?? "Medium",
      assignee: f.assignee?.displayName ?? "Unassigned",
      updated: f.updated ?? "",
      url: `${baseUrl}/browse/${raw.key}`,
      description:
        typeof f.description === "string"
          ? f.description
          : JSON.stringify(f.description ?? ""),
    };
    return jiraToDefect(summary);
  });
}

function jiraToDefect(i: JiraIssueSummary): HistoricDefect {
  const text = `${i.summary}\n${i.description}\n${i.issuetype}`;
  return {
    key: i.key,
    summary: i.summary,
    severity: severityFromPriority(i.priority),
    status: i.status,
    areas: inferAreas(text),
    source: "jira",
    url: i.url,
    description: i.description?.slice(0, 1500),
  };
}

export type DefectRiskProfile = {
  defects: HistoricDefect[];
  /** area → weighted risk score */
  areaScores: Record<string, number>;
  defectCountByArea: Record<string, number>;
  message: string;
};

function severityWeight(s: HistoricDefect["severity"]): number {
  switch (s) {
    case "Critical":
      return 5;
    case "High":
      return 3;
    case "Medium":
      return 2;
    default:
      return 1;
  }
}

/** Load Jira bugs + local prod defect history and score areas. */
export async function loadDefectRiskProfile(): Promise<DefectRiskProfile> {
  const local = loadLocalDefects();
  let jira: HistoricDefect[] = [];
  try {
    jira = await fetchJiraBugs(40);
  } catch (e) {
    console.warn(
      "[defects] Jira bug fetch failed:",
      e instanceof Error ? e.message : e
    );
  }

  // Prefer union by key (jira wins)
  const byKey = new Map<string, HistoricDefect>();
  for (const d of local) byKey.set(d.key, d);
  for (const d of jira) byKey.set(d.key, d);
  const defects = [...byKey.values()];

  const areaScores: Record<string, number> = {};
  const defectCountByArea: Record<string, number> = {};
  for (const d of defects) {
    for (const area of d.areas) {
      defectCountByArea[area] = (defectCountByArea[area] ?? 0) + 1;
      areaScores[area] =
        (areaScores[area] ?? 0) + severityWeight(d.severity);
    }
  }

  return {
    defects,
    areaScores,
    defectCountByArea,
    message: jira.length
      ? `Loaded ${defects.length} defects (${jira.length} from Jira, ${local.length} local)`
      : `Loaded ${defects.length} local historic defects (set JIRA_API_TOKEN to include live Bugs)`,
  };
}

export function formatDefectsMarkdown(profile: DefectRiskProfile): string {
  const lines = [
    `# Historic defect risk profile`,
    ``,
    profile.message,
    `Synced: ${new Date().toISOString()}`,
    ``,
    `## Area risk scores`,
    ``,
    ...Object.entries(profile.areaScores)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([area, score]) =>
          `- **${area}**: score=${score}, defects=${profile.defectCountByArea[area] ?? 0}`
      ),
    ``,
    `## Defects`,
    ``,
  ];
  for (const d of profile.defects.slice(0, 40)) {
    lines.push(
      `- **${d.key}** [${d.severity}] (${d.source}) — ${d.summary} — areas: ${d.areas.join(", ")}`
    );
  }
  return lines.join("\n");
}

export async function syncDefectsToDocs(): Promise<{
  ok: boolean;
  written: string[];
  message: string;
  profile: DefectRiskProfile;
}> {
  const profile = await loadDefectRiskProfile();
  const outDir = path.join(QA_DOCS_DIR, "jira", "live");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "historic-defects.md");
  fs.writeFileSync(file, formatDefectsMarkdown(profile) + "\n");
  return {
    ok: profile.defects.length > 0,
    written: [file],
    message: profile.message,
    profile,
  };
}
