/** Shared Atlassian Cloud auth (Jira + Confluence use the same email + API token). */
import { withRetry } from "../lib/retry";

export function getAtlassianConfig() {
  const baseUrl = (
    process.env.JIRA_BASE_URL ??
    process.env.ATLASSIAN_BASE_URL ??
    ""
  )
    .trim()
    .replace(/\/$/, "");
  const email = (
    process.env.JIRA_EMAIL ??
    process.env.ATLASSIAN_EMAIL ??
    ""
  ).trim();
  const token = (
    process.env.JIRA_API_TOKEN ??
    process.env.ATLASSIAN_API_TOKEN ??
    ""
  ).trim();
  const projectKey = (process.env.JIRA_PROJECT_KEY ?? "").trim();
  return { baseUrl, email, token, projectKey };
}

export function isAtlassianConfigured(): boolean {
  const { baseUrl, email, token } = getAtlassianConfig();
  return Boolean(baseUrl && email && token);
}

export function atlassianAuthHeader(): string {
  const { email, token } = getAtlassianConfig();
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}

export async function atlassianFetch(
  pathOrUrl: string,
  init: RequestInit = {}
): Promise<Response> {
  const { baseUrl } = getAtlassianConfig();
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  return withRetry(
    async () => {
      const res = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: atlassianAuthHeader(),
          ...(init.headers ?? {}),
        },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`Atlassian HTTP ${res.status}`);
      }
      return res;
    },
    { attempts: 3, baseDelayMs: 400, label: "atlassian" }
  );
}

/** Flatten Atlassian Document Format (ADF) to plain text. */
export function adfToText(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (typeof node !== "object") return String(node);
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const kids = node.content ? adfToText(node.content) : "";
  if (node.type === "paragraph" || node.type === "heading") return kids + "\n";
  if (node.type === "listItem") return `- ${kids}\n`;
  return kids;
}
