/**
 * Live Confluence Cloud connector (same Atlassian site as Jira).
 *
 * Uses JIRA_EMAIL / JIRA_API_TOKEN (or ATLASSIAN_*).
 * Optional: CONFLUENCE_SPACE_KEY=...
 */
import fs from "node:fs";
import path from "node:path";
import { QA_DOCS_DIR } from "../core/config";
import {
  atlassianFetch,
  getAtlassianConfig,
  isAtlassianConfigured,
} from "./atlassianAuth";

export function isConfluenceConfigured(): boolean {
  return isAtlassianConfigured();
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export async function syncConfluenceToDocs(): Promise<{
  ok: boolean;
  written: string[];
  message: string;
}> {
  if (!isConfluenceConfigured()) {
    return {
      ok: false,
      written: [],
      message:
        "Confluence not configured. Set JIRA_EMAIL + JIRA_API_TOKEN (same Atlassian token).",
    };
  }

  const { baseUrl } = getAtlassianConfig();
  const spaceKey = (process.env.CONFLUENCE_SPACE_KEY ?? "").trim();
  const outDir = path.join(QA_DOCS_DIR, "confluence", "live");
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  const cql = spaceKey
    ? `type=page AND space=${spaceKey} ORDER BY lastmodified DESC`
    : `type=page ORDER BY lastmodified DESC`;

  const res = await atlassianFetch(
    `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=25&expand=body.storage,space,version`
  );

  if (!res.ok) {
    const body = await res.text();
    // Site may not have Confluence enabled
    return {
      ok: false,
      written: [],
      message: `Confluence API error ${res.status}: ${body.slice(0, 300)}`,
    };
  }

  const data = (await res.json()) as { results?: any[] };
  const pages = data.results ?? [];

  for (const page of pages) {
    const title = page.title ?? "Untitled";
    const id = page.id ?? "unknown";
    const space = page.space?.key ?? "NOSPACE";
    const html = page.body?.storage?.value ?? "";
    const text = stripHtml(html);
    const safe = title.replace(/[^\w\-]+/g, "_").slice(0, 80);
    const md = [
      `# ${title}`,
      ``,
      `- Confluence ID: ${id}`,
      `- Space: ${space}`,
      `- Version: ${page.version?.number ?? "n/a"}`,
      `- URL: ${baseUrl}/wiki${page._links?.webui ?? ""}`,
      ``,
      `## Body`,
      text || "(empty page)",
      ``,
    ].join("\n");
    const file = path.join(outDir, `${space}-${id}-${safe}.md`);
    fs.writeFileSync(file, md);
    written.push(file);
  }

  return {
    ok: pages.length > 0,
    written,
    message: pages.length
      ? `Synced ${pages.length} Confluence page(s)`
      : "Confluence returned 0 pages (create a space/page or set CONFLUENCE_SPACE_KEY)",
  };
}
