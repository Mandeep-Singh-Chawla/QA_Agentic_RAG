/**
 * Live GitHub connector for user Mandeep-Singh-Chawla.
 * Public repo listing works WITHOUT a token.
 * GITHUB_TOKEN unlocks private repos + higher rate limits.
 */
import fs from "node:fs";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { QA_DOCS_DIR } from "../config";

const DEFAULT_USER = "Mandeep-Singh-Chawla";

const AUTOMATION_PREFERRED = [
  "Selenium-Framework",
  "RestAssured-Framework-and-Important-Utilities",
  "Appium-Framework",
  "JaCoCo",
  "Google-sheet-Integration",
  "ExtentReports",
  "TestNG",
  "Cucumber",
  "Playwright",
  "Cypress",
  "API",
  "Automation",
  "Framework",
];

export type GithubRepoSummary = {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics: string[];
  private: boolean;
  fork: boolean;
  stargazers_count: number;
  updated_at: string | null;
};

function getToken(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || undefined;
}

export function getGithubUser(): string {
  return process.env.GITHUB_USER?.trim() || DEFAULT_USER;
}

function getSingleRepo(): { owner: string; repo: string } | null {
  const full = process.env.GITHUB_REPO?.trim();
  if (!full?.includes("/")) return null;
  const [owner, repo] = full.split("/");
  return { owner, repo };
}

/** Always "configured" — public listing works without token. */
export function isGithubConfigured(): boolean {
  return true;
}

export function getOctokit(): Octokit {
  const token = getToken();
  return token ? new Octokit({ auth: token }) : new Octokit();
}

export function parseOwnerRepo(full: string): { owner: string; repo: string } {
  const clean = full
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "");
  const [owner, repo] = clean.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo: ${full}`);
  return { owner, repo };
}

function looksAutomation(r: GithubRepoSummary): boolean {
  const hay = `${r.name} ${r.description ?? ""} ${r.topics.join(" ")}`.toLowerCase();
  return AUTOMATION_PREFERRED.some((p) => hay.includes(p.toLowerCase()));
}

function scoreRepo(r: GithubRepoSummary): number {
  let score = 0;
  for (const p of AUTOMATION_PREFERRED) {
    if (r.name.toLowerCase().includes(p.toLowerCase())) score += 10;
    else if ((r.description ?? "").toLowerCase().includes(p.toLowerCase()))
      score += 3;
  }
  if (!r.fork) score += 2;
  score += Math.min(r.stargazers_count, 20);
  return score;
}

/** Live list of repos for the configured GitHub user (public API OK). */
export async function listGithubRepos(opts?: {
  automationOnly?: boolean;
  limit?: number;
}): Promise<{
  ok: boolean;
  user: string;
  repos: GithubRepoSummary[];
  message: string;
}> {
  const user = getGithubUser();
  const octokit = getOctokit();
  const limit = opts?.limit ?? 50;

  try {
    const collected: GithubRepoSummary[] = [];
    let page = 1;
    while (collected.length < limit && page <= 3) {
      const res = await octokit.repos.listForUser({
        username: user,
        per_page: Math.min(100, limit),
        page,
        sort: "updated",
        type: "owner",
      });
      if (!res.data.length) break;
      for (const r of res.data) {
        collected.push({
          name: r.name,
          full_name: r.full_name,
          html_url: r.html_url,
          description: r.description,
          language: r.language,
          topics: r.topics ?? [],
          private: r.private,
          fork: r.fork,
          stargazers_count: r.stargazers_count,
          updated_at: r.updated_at,
        });
      }
      if (res.data.length < 100) break;
      page += 1;
    }

    let repos = collected.sort((a, b) => scoreRepo(b) - scoreRepo(a));
    if (opts?.automationOnly) {
      const filtered = repos.filter(looksAutomation);
      if (filtered.length) repos = filtered;
    }
    repos = repos.slice(0, limit);

    return {
      ok: true,
      user,
      repos,
      message: `Found ${repos.length} repo(s) for ${user}`,
    };
  } catch (e) {
    return {
      ok: false,
      user,
      repos: [],
      message: `GitHub list failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function formatReposMarkdown(
  user: string,
  repos: GithubRepoSummary[],
  title = "GitHub repositories"
): string {
  const lines = [
    `# ${title} — ${user}`,
    ``,
    `Fetched live from GitHub API.`,
    ``,
  ];
  for (const r of repos) {
    const tags = [
      r.language ?? "n/a",
      r.private ? "private" : "public",
      r.fork ? "fork" : "own",
      `★${r.stargazers_count}`,
    ].join(" · ");
    lines.push(`## ${r.name}`);
    lines.push(`- **URL:** ${r.html_url}`);
    lines.push(`- **Meta:** ${tags}`);
    if (r.description) lines.push(`- **Description:** ${r.description}`);
    if (r.topics.length) lines.push(`- **Topics:** ${r.topics.join(", ")}`);
    lines.push(``);
  }
  if (!repos.length) {
    lines.push(`_No repositories found._`);
  }
  return lines.join("\n");
}

async function writeRepoDocs(
  octokit: Octokit,
  owner: string,
  repo: string,
  outDir: string
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  try {
    const readme = await octokit.repos.getReadme({ owner, repo });
    const content = Buffer.from(readme.data.content, "base64").toString("utf8");
    const file = path.join(outDir, "README.md");
    fs.writeFileSync(
      file,
      [
        `# GitHub — ${owner}/${repo}`,
        ``,
        `Source: ${readme.data.html_url}`,
        ``,
        content.slice(0, 12000),
        ``,
      ].join("\n")
    );
    written.push(file);
  } catch {
    /* no readme */
  }

  try {
    const pulls = await octokit.pulls.list({
      owner,
      repo,
      state: "all",
      per_page: 8,
      sort: "updated",
      direction: "desc",
    });
    if (pulls.data.length) {
      const md = [
        `# Recent PRs — ${owner}/${repo}`,
        ``,
        ...pulls.data.flatMap((p) => [
          `## PR #${p.number}: ${p.title}`,
          `- State: ${p.state}${p.merged_at ? " (merged)" : ""}`,
          `- Author: ${p.user?.login ?? "unknown"}`,
          `- URL: ${p.html_url}`,
          ``,
          (p.body ?? "").slice(0, 1200),
          ``,
          `---`,
          ``,
        ]),
      ].join("\n");
      const file = path.join(outDir, "recent-prs.md");
      fs.writeFileSync(file, md);
      written.push(file);
    }
  } catch {
    /* ignore — often needs auth */
  }

  return written;
}

export async function syncGithubToDocs(): Promise<{
  ok: boolean;
  written: string[];
  message: string;
}> {
  const octokit = getOctokit();
  const written: string[] = [];
  const single = getSingleRepo();
  const user = getGithubUser();

  if (single) {
    const outDir = path.join(QA_DOCS_DIR, "github", "live", single.repo);
    written.push(
      ...(await writeRepoDocs(octokit, single.owner, single.repo, outDir))
    );
    return {
      ok: written.length > 0,
      written,
      message: `Synced GitHub repo ${single.owner}/${single.repo} (${written.length} files)`,
    };
  }

  const listed = await listGithubRepos({ limit: 40 });
  if (!listed.ok || !listed.repos.length) {
    return {
      ok: false,
      written: [],
      message: listed.message,
    };
  }

  const allMd = formatReposMarkdown(user, listed.repos, "All GitHub repositories");
  const allFile = path.join(QA_DOCS_DIR, "github", "live", "my-repos.md");
  fs.mkdirSync(path.dirname(allFile), { recursive: true });
  fs.writeFileSync(allFile, allMd + "\n");
  written.push(allFile);

  const autoRepos = listed.repos.filter(looksAutomation);
  const autoList = autoRepos.length ? autoRepos : listed.repos.slice(0, 8);
  const autoMd = formatReposMarkdown(
    user,
    autoList,
    "Automation / QA framework repositories"
  );
  const autoFile = path.join(
    QA_DOCS_DIR,
    "github",
    "live",
    "my-automation-repos.md"
  );
  fs.writeFileSync(autoFile, autoMd + "\n");
  written.push(autoFile);

  const index: string[] = [`# GitHub user sync — ${user}`, ``];
  for (const r of autoList.slice(0, 6)) {
    const outDir = path.join(QA_DOCS_DIR, "github", "live", r.name);
    const files = await writeRepoDocs(octokit, user, r.name, outDir);
    written.push(...files);
    index.push(
      `- **${r.full_name}** — ${r.description ?? ""} — ${r.html_url}`
    );
  }

  const indexFile = path.join(QA_DOCS_DIR, "github", "live", "INDEX.md");
  fs.writeFileSync(indexFile, index.join("\n") + "\n");
  written.push(indexFile);

  return {
    ok: written.length > 0,
    written,
    message: `Synced GitHub for ${user}: ${listed.repos.length} repos listed, ${autoList.length} detailed (${written.length} files). Token=${getToken() ? "yes" : "no (public only)"}`,
  };
}
