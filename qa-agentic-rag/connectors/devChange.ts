/**
 * Fetch code changes from the configured DEV repo (default: confident-ai/deepeval).
 * Supports PR URL/number or latest commits on the default branch.
 * Caches successful fetches so rate-limit failures can fall back to disk.
 */
import fs from "node:fs";
import path from "node:path";
import { DEV_REPO, QA_DOCS_DIR } from "../config";
import { getOctokit, parseOwnerRepo } from "./github";

export type ChangedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

export type DevChangeSet = {
  ok: boolean;
  message: string;
  repo: string;
  refLabel: string;
  htmlUrl: string;
  files: ChangedFile[];
  summary: string;
  fromCache?: boolean;
};

function hasGithubToken(): boolean {
  return Boolean(process.env.GITHUB_TOKEN?.trim());
}

function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number })?.status;
  return (
    status === 403 ||
    status === 429 ||
    /rate limit|secondary rate|API rate limit/i.test(msg)
  );
}

function rateLimitHint(): string {
  if (hasGithubToken()) {
    return "GitHub API rate limit hit even with GITHUB_TOKEN — wait a minute and retry.";
  }
  return (
    "GitHub API rate limit hit (unauthenticated). " +
    "Set GITHUB_TOKEN in .env (https://github.com/settings/tokens — classic PAT with public_repo), " +
    "restart Studio, then retry."
  );
}

function cacheDir(): string {
  const dir = path.join(QA_DOCS_DIR, "github", "live", "dev-deepeval");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheJsonPath(label: string): string {
  const safe = label.replace(/[^\w.-]+/g, "_");
  return path.join(cacheDir(), `change-${safe}.json`);
}

function writeChangeCache(change: DevChangeSet) {
  if (!change.ok || !change.files.length) return;
  const payload = {
    ...change,
    cachedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    cacheJsonPath(change.refLabel),
    JSON.stringify(payload, null, 2)
  );
  fs.writeFileSync(
    path.join(cacheDir(), "latest-change.json"),
    JSON.stringify(payload, null, 2)
  );
  fs.writeFileSync(
    path.join(cacheDir(), "latest-change.md"),
    change.summary + "\n"
  );
}

function readJsonCache(file: string): DevChangeSet | null {
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!data?.files?.length) return null;
    return {
      ok: true,
      message: `Loaded cached change ${data.refLabel} (GitHub API unavailable)`,
      repo: data.repo,
      refLabel: data.refLabel,
      htmlUrl: data.htmlUrl,
      files: data.files,
      summary: data.summary,
      fromCache: true,
    };
  } catch {
    return null;
  }
}

function loadCachedChange(prNumber?: number): DevChangeSet | null {
  if (prNumber) {
    const hit = readJsonCache(cacheJsonPath(`PR_${prNumber}`));
    if (hit) return hit;
  }
  return readJsonCache(path.join(cacheDir(), "latest-change.json"));
}

function truncatePatch(patch?: string, max = 1200): string | undefined {
  if (!patch) return undefined;
  return patch.length > max ? patch.slice(0, max) + "\n…(truncated)" : patch;
}

export function parsePrRef(input?: string): {
  owner?: string;
  repo?: string;
  prNumber?: number;
} {
  if (!input?.trim()) return {};
  const s = input.trim();
  const url = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (url) {
    return {
      owner: url[1],
      repo: url[2],
      prNumber: Number(url[3]),
    };
  }
  if (/^\d+$/.test(s)) return { prNumber: Number(s) };
  return {};
}

function formatCommitSummary(
  owner: string,
  repo: string,
  ref: string,
  message: string,
  htmlUrl: string,
  files: ChangedFile[]
): string {
  return [
    `# Dev change set — ${owner}/${repo} @ ${ref}`,
    ``,
    `- Message: ${message.split("\n")[0]}`,
    `- URL: ${htmlUrl}`,
    `- Files changed: ${files.length}`,
    ``,
    `## Files`,
    ...files.map(
      (f) =>
        `- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`
    ),
    ``,
    `## Patches (truncated)`,
    ...files.flatMap((f) =>
      f.patch
        ? [`### ${f.filename}`, "```diff", f.patch, "```", ``]
        : [`### ${f.filename}`, "_(no patch)_", ``]
    ),
  ].join("\n");
}

async function fetchLatestCommits(
  owner: string,
  repo: string,
  maxFiles: number
): Promise<DevChangeSet> {
  const octokit = getOctokit();
  const repoInfo = await octokit.repos.get({ owner, repo });
  const branch = repoInfo.data.default_branch;
  const commits = await octokit.repos.listCommits({
    owner,
    repo,
    sha: branch,
    per_page: 2,
  });
  if (commits.data.length < 1) {
    return {
      ok: false,
      message: "No commits found",
      repo: `${owner}/${repo}`,
      refLabel: branch,
      htmlUrl: repoInfo.data.html_url,
      files: [],
      summary: "",
    };
  }

  const head = commits.data[0].sha;
  const base = commits.data[1]?.sha;

  if (!base || base === head) {
    const commit = await octokit.repos.getCommit({ owner, repo, ref: head });
    const files: ChangedFile[] = (commit.data.files ?? [])
      .slice(0, maxFiles)
      .map((f) => ({
        filename: f.filename ?? "unknown",
        status: f.status ?? "modified",
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        changes: f.changes ?? 0,
        patch: truncatePatch(f.patch),
      }));
    const summary = formatCommitSummary(
      owner,
      repo,
      head.slice(0, 7),
      commit.data.commit.message,
      commit.data.html_url,
      files
    );
    return {
      ok: true,
      message: `Loaded latest commit ${head.slice(0, 7)} (${files.length} files)`,
      repo: `${owner}/${repo}`,
      refLabel: head.slice(0, 7),
      htmlUrl: commit.data.html_url,
      files,
      summary,
    };
  }

  const compare = await octokit.repos.compareCommits({
    owner,
    repo,
    base,
    head,
  });
  const files: ChangedFile[] = (compare.data.files ?? [])
    .slice(0, maxFiles)
    .map((f) => ({
      filename: f.filename ?? "unknown",
      status: f.status ?? "modified",
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      changes: f.changes ?? 0,
      patch: truncatePatch(f.patch),
    }));
  const summary = formatCommitSummary(
    owner,
    repo,
    `${base.slice(0, 7)}...${head.slice(0, 7)}`,
    commits.data[0].commit.message,
    compare.data.html_url,
    files
  );
  return {
    ok: true,
    message: `Compared latest commits (${files.length} files)`,
    repo: `${owner}/${repo}`,
    refLabel: `${base.slice(0, 7)}...${head.slice(0, 7)}`,
    htmlUrl: compare.data.html_url,
    files,
    summary,
  };
}

/** Load PR files or latest commits' file changes from DEV_REPO. */
export async function fetchDevChangeSet(opts?: {
  prOrUrl?: string;
  maxFiles?: number;
  /** If PR fetch fails (e.g. rate limit), try latest default-branch commits. */
  fallbackToLatest?: boolean;
}): Promise<DevChangeSet> {
  const defaults = parseOwnerRepo(DEV_REPO);
  const parsed = parsePrRef(opts?.prOrUrl);
  const owner = parsed.owner ?? defaults.owner;
  const repo = parsed.repo ?? defaults.repo;
  const maxFiles = opts?.maxFiles ?? 40;
  const fallbackToLatest = opts?.fallbackToLatest !== false;
  const octokit = getOctokit();

  try {
    if (parsed.prNumber) {
      const pr = await octokit.pulls.get({
        owner,
        repo,
        pull_number: parsed.prNumber,
      });
      const filesRes = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: parsed.prNumber,
        per_page: maxFiles,
      });
      const files: ChangedFile[] = filesRes.data.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: truncatePatch(f.patch),
      }));
      const summary = [
        `# Dev change set — ${owner}/${repo} PR #${parsed.prNumber}`,
        ``,
        `- Title: ${pr.data.title}`,
        `- Author: ${pr.data.user?.login ?? "n/a"}`,
        `- Base ← Head: ${pr.data.base.ref} ← ${pr.data.head.ref}`,
        `- URL: ${pr.data.html_url}`,
        `- Files changed: ${files.length}`,
        ``,
        `## Files`,
        ...files.map(
          (f) =>
            `- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`
        ),
        ``,
        `## Patches (truncated)`,
        ...files.flatMap((f) =>
          f.patch
            ? [`### ${f.filename}`, "```diff", f.patch, "```", ``]
            : [`### ${f.filename}`, "_(no patch)_", ``]
        ),
      ].join("\n");

      const result: DevChangeSet = {
        ok: true,
        message: `Loaded PR #${parsed.prNumber} with ${files.length} file(s)`,
        repo: `${owner}/${repo}`,
        refLabel: `PR #${parsed.prNumber}`,
        htmlUrl: pr.data.html_url,
        files,
        summary,
      };
      writeChangeCache(result);
      return result;
    }

    const latest = await fetchLatestCommits(owner, repo, maxFiles);
    if (latest.ok) writeChangeCache(latest);
    return latest;
  } catch (e) {
    const rateLimited = isRateLimitError(e);
    const cached = loadCachedChange(parsed.prNumber);
    if (cached) {
      return {
        ...cached,
        message:
          `${cached.message}. ` +
          (rateLimited ? rateLimitHint() : String((e as Error)?.message ?? e)),
      };
    }

    if (rateLimited && parsed.prNumber && fallbackToLatest) {
      try {
        const latest = await fetchLatestCommits(owner, repo, maxFiles);
        if (latest.ok) {
          writeChangeCache(latest);
          return {
            ...latest,
            message:
              `PR #${parsed.prNumber} unavailable (${rateLimitHint()}). ` +
              `Fell back to latest default-branch commits instead.`,
          };
        }
      } catch {
        /* fall through */
      }
    }

    return {
      ok: false,
      message: rateLimited
        ? rateLimitHint()
        : `Failed to fetch dev changes: ${e instanceof Error ? e.message : String(e)}`,
      repo: `${owner}/${repo}`,
      refLabel: parsed.prNumber ? `PR #${parsed.prNumber}` : "n/a",
      htmlUrl: parsed.prNumber
        ? `https://github.com/${owner}/${repo}/pull/${parsed.prNumber}`
        : `https://github.com/${owner}/${repo}`,
      files: [],
      summary: "",
    };
  }
}

/** Persist latest change set for RAG indexing. */
export async function syncDevChangeToDocs(prOrUrl?: string): Promise<{
  ok: boolean;
  written: string[];
  message: string;
  change?: DevChangeSet;
}> {
  const change = await fetchDevChangeSet({ prOrUrl });
  if (!change.ok) {
    return { ok: false, written: [], message: change.message, change };
  }
  writeChangeCache(change);
  const file = path.join(cacheDir(), "latest-change.md");
  return {
    ok: true,
    written: [file, cacheJsonPath(change.refLabel)],
    message: `Synced dev change ${change.refLabel} (${change.files.length} files)${
      change.fromCache ? " [cache]" : ""
    }`,
    change,
  };
}
