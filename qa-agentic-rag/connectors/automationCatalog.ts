/**
 * Build a catalog of automated tests from QA automation repos
 * listed in AUTOMATION_REPOS (Selenium / RestAssured / Appium / etc.).
 */
import fs from "node:fs";
import path from "node:path";
import { AUTOMATION_REPOS, QA_DOCS_DIR } from "../core/config";
import { getOctokit, parseOwnerRepo } from "./github";

export type AutomationTestEntry = {
  repo: string;
  path: string;
  name: string;
  framework: "selenium" | "restassured" | "appium" | "other";
  tags: string[];
  url: string;
};

const TEST_PATH_RE =
  /(test|tests|spec)\/.*\.(java|py|ts|js|feature)$|.*Test(s)?\.(java|py|ts|js)$|.*_test\.py$/i;

function frameworkOf(repo: string): AutomationTestEntry["framework"] {
  const r = repo.toLowerCase();
  if (r.includes("selenium")) return "selenium";
  if (r.includes("restassured") || r.includes("rest-assured"))
    return "restassured";
  if (r.includes("appium")) return "appium";
  return "other";
}

function tagsFromPath(filePath: string): string[] {
  const lower = filePath.toLowerCase();
  const tags = new Set<string>();
  const keywords = [
    "login",
    "auth",
    "api",
    "checkout",
    "cart",
    "payment",
    "mobile",
    "android",
    "ios",
    "smoke",
    "regression",
    "lockout",
    "user",
    "account",
    "metric",
    "eval",
    "evaluate",
    "prompt",
    "dataset",
    "guard",
    "security",
    "ui",
  ];
  for (const k of keywords) {
    if (lower.includes(k)) tags.add(k);
  }
  const base = path.basename(filePath, path.extname(filePath));
  tags.add(base.toLowerCase());
  return [...tags];
}

export async function buildAutomationCatalog(opts?: {
  maxPerRepo?: number;
}): Promise<{
  ok: boolean;
  message: string;
  tests: AutomationTestEntry[];
}> {
  const octokit = getOctokit();
  const maxPerRepo = opts?.maxPerRepo ?? 80;
  const tests: AutomationTestEntry[] = [];

  for (const full of AUTOMATION_REPOS) {
    try {
      const { owner, repo } = parseOwnerRepo(full);
      const info = await octokit.repos.get({ owner, repo });
      const branch = info.data.default_branch;
      const ref = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      const tree = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: ref.data.object.sha,
        recursive: "true",
      });

      const files = (tree.data.tree ?? [])
        .filter((t) => t.type === "blob" && t.path && TEST_PATH_RE.test(t.path))
        .slice(0, maxPerRepo);

      for (const f of files) {
        const p = f.path!;
        tests.push({
          repo: `${owner}/${repo}`,
          path: p,
          name: path.basename(p, path.extname(p)),
          framework: frameworkOf(repo),
          tags: tagsFromPath(p),
          url: `https://github.com/${owner}/${repo}/blob/${branch}/${p}`,
        });
      }
    } catch (e) {
      console.warn(
        `[automation-catalog] skip ${full}:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  return {
    ok: tests.length > 0,
    message: tests.length
      ? `Catalogued ${tests.length} test file(s) across ${AUTOMATION_REPOS.length} automation repo(s)`
      : `No test files found in automation repos (check AUTOMATION_REPOS / rate limit)`,
    tests,
  };
}

export function formatCatalogMarkdown(tests: AutomationTestEntry[]): string {
  const lines = [
    `# Automation test catalog`,
    ``,
    `Source repos: ${AUTOMATION_REPOS.join(", ")}`,
    `Count: ${tests.length}`,
    `Synced: ${new Date().toISOString()}`,
    ``,
  ];
  const byRepo = new Map<string, AutomationTestEntry[]>();
  for (const t of tests) {
    const arr = byRepo.get(t.repo) ?? [];
    arr.push(t);
    byRepo.set(t.repo, arr);
  }
  for (const [repo, list] of byRepo) {
    lines.push(`## ${repo} (${list[0]?.framework ?? "other"})`);
    lines.push(``);
    for (const t of list) {
      lines.push(
        `- **${t.name}** — \`${t.path}\` — tags: ${t.tags.slice(0, 8).join(", ")} — ${t.url}`
      );
    }
    lines.push(``);
  }
  return lines.join("\n");
}

export async function syncAutomationCatalogToDocs(): Promise<{
  ok: boolean;
  written: string[];
  message: string;
  tests: AutomationTestEntry[];
}> {
  const built = await buildAutomationCatalog();
  const outDir = path.join(QA_DOCS_DIR, "github", "live");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "automation-test-catalog.md");
  fs.writeFileSync(file, formatCatalogMarkdown(built.tests) + "\n");

  // Lightweight per-repo index for RAG
  const written = [file];
  const byRepo = new Map<string, AutomationTestEntry[]>();
  for (const t of built.tests) {
    const arr = byRepo.get(t.repo) ?? [];
    arr.push(t);
    byRepo.set(t.repo, arr);
  }
  for (const [repo, list] of byRepo) {
    const short = repo.split("/")[1] ?? repo;
    const dir = path.join(outDir, short);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "test-catalog.md");
    fs.writeFileSync(f, formatCatalogMarkdown(list) + "\n");
    written.push(f);
  }

  return {
    ok: built.ok,
    written,
    message: built.message,
    tests: built.tests,
  };
}
