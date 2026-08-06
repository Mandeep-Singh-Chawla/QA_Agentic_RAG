/**
 * Test Selection Agent — change-impact selection of automated tests.
 * DEV_REPO diff → select automated TCs from AUTOMATION_REPOS.
 */
import { createAgent, initChatModel } from "langchain";
import z from "zod";
import { AUTOMATION_REPOS, DEV_REPO, LITE_MODEL } from "../config";
import {
  buildAutomationCatalog,
  syncAutomationCatalogToDocs,
  type AutomationTestEntry,
} from "../connectors/automationCatalog";
import {
  fetchDevChangeSet,
  syncDevChangeToDocs,
  type DevChangeSet,
} from "../connectors/devChange";

export type SelectedTest = {
  repo: string;
  name: string;
  path: string;
  framework: string;
  reason: string;
  priority: "Critical" | "High" | "Medium" | "Low";
  url: string;
  score: number;
};

export type ImpactSelectionResult = {
  ok: boolean;
  message: string;
  devRepo: string;
  changeRef: string;
  changeUrl: string;
  riskLevel: "Critical" | "High" | "Medium" | "Low";
  riskAreas: string[];
  changedFiles: string[];
  selectedTests: SelectedTest[];
  runCommands: string[];
  notes: string[];
};

/** Map deepeval / LLM-eval code areas → automation risk tags. */
const AREA_RULES: { pattern: RegExp; areas: string[]; tags: string[] }[] = [
  {
    pattern: /metric|evaluate|evaluation|scorer|deepeval/i,
    areas: ["llm-evaluation", "api"],
    tags: ["api", "eval", "metric", "regression"],
  },
  {
    pattern: /prompt|dataset|test_case|golden/i,
    areas: ["test-data", "api"],
    tags: ["api", "dataset", "regression"],
  },
  {
    pattern: /guard|safety|security|pii|jailbreak/i,
    areas: ["security"],
    tags: ["security", "guard", "api"],
  },
  {
    pattern: /(^|\/)(auth|login|session)(\/|$)|oauth|jwt|password/i,
    areas: ["auth"],
    tags: ["login", "auth", "security", "api"],
  },
  {
    pattern: /api|http|client|rest|endpoint/i,
    areas: ["api"],
    tags: ["api", "restassured"],
  },
  {
    pattern: /ui|frontend|component|page/i,
    areas: ["ui"],
    tags: ["ui", "selenium", "smoke"],
  },
  {
    pattern: /mobile|android|ios/i,
    areas: ["mobile"],
    tags: ["mobile", "appium", "android"],
  },
];

function detectAreas(change: DevChangeSet): string[] {
  const hay = change.files
    .map((f) => `${f.filename} ${f.patch ?? ""}`)
    .join("\n");
  const areas = new Set<string>();
  for (const rule of AREA_RULES) {
    if (rule.pattern.test(hay)) rule.areas.forEach((a) => areas.add(a));
  }
  if (!areas.size) areas.add("regression-smoke");
  return [...areas];
}

function wantedTags(change: DevChangeSet): string[] {
  const hay = change.files
    .map((f) => `${f.filename} ${f.patch ?? ""}`)
    .join("\n")
    .toLowerCase();
  const tags = new Set<string>(["smoke", "regression"]);
  for (const rule of AREA_RULES) {
    if (rule.pattern.test(hay)) rule.tags.forEach((t) => tags.add(t));
  }
  // tokens from file names
  for (const f of change.files) {
    for (const part of f.filename.toLowerCase().split(/[\/_.-]+/)) {
      if (part.length > 3) tags.add(part);
    }
  }
  return [...tags];
}

function scoreTest(
  test: AutomationTestEntry,
  tags: string[],
  areas: string[]
): number {
  let score = 0;
  const tagSet = new Set(tags);
  for (const t of test.tags) {
    if (tagSet.has(t)) score += 5;
  }
  if (areas.includes("api") && test.framework === "restassured") score += 8;
  if (areas.includes("ui") && test.framework === "selenium") score += 8;
  if (areas.includes("mobile") && test.framework === "appium") score += 8;
  if (areas.includes("auth") && test.tags.some((t) => /login|auth/.test(t)))
    score += 10;
  if (areas.includes("llm-evaluation") && test.framework === "restassured")
    score += 6;
  if (test.tags.includes("smoke")) score += 2;
  // Prefer own (non-huge) frameworks slightly
  if (test.framework !== "other") score += 1;
  return score;
}

function riskFromChange(change: DevChangeSet, areas: string[]): ImpactSelectionResult["riskLevel"] {
  const lines = change.files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (areas.includes("security") || areas.includes("auth")) return "Critical";
  if (areas.includes("api") || areas.includes("llm-evaluation")) {
    return lines > 50 ? "High" : "Medium";
  }
  if (lines <= 10) return "Low";
  if (lines <= 40) return "Medium";
  return "High";
}

function buildRunCommands(selected: SelectedTest[]): string[] {
  const byRepo = new Map<string, SelectedTest[]>();
  for (const t of selected) {
    const arr = byRepo.get(t.repo) ?? [];
    arr.push(t);
    byRepo.set(t.repo, arr);
  }
  const cmds: string[] = [];
  for (const [repo, tests] of byRepo) {
    const names = [...new Set(tests.map((t) => t.name))].slice(0, 12);
    const short = repo.split("/")[1] ?? repo;
    if (/restassured/i.test(repo)) {
      cmds.push(
        `# ${short}\ncd <clone ${repo}> && mvn test -Dtest=${names.join(",")}`
      );
    } else if (/selenium/i.test(repo)) {
      cmds.push(
        `# ${short}\ncd <clone ${repo}> && mvn test -Dtest=${names.join(",")}`
      );
    } else if (/appium/i.test(repo)) {
      cmds.push(
        `# ${short}\ncd <clone ${repo}> && mvn test -Dtest=${names.join(",")}`
      );
    } else {
      cmds.push(`# ${short}\n# Run: ${names.join(", ")}`);
    }
  }
  if (!cmds.length) {
    cmds.push(
      "# No mapped tests — run smoke suite manually in Selenium-Framework"
    );
  }
  return cmds;
}

const llmSchema = z.object({
  riskLevel: z.enum(["Critical", "High", "Medium", "Low"]),
  riskAreas: z.array(z.string()),
  picks: z.array(
    z.object({
      name: z.string(),
      repo: z.string(),
      reason: z.string(),
      priority: z.enum(["Critical", "High", "Medium", "Low"]),
    })
  ),
  notes: z.array(z.string()),
});

async function refineWithLlm(
  change: DevChangeSet,
  candidates: SelectedTest[]
): Promise<z.infer<typeof llmSchema> | null> {
  if ((process.env.QA_IMPACT_LLM ?? "true").toLowerCase() === "false") {
    return null;
  }
  try {
    const model = await initChatModel(LITE_MODEL, {
      temperature: 0,
      maxOutputTokens: 1024,
    });
    const agent = createAgent({
      model,
      tools: [],
      systemPrompt: `You select automated regression tests for a developer code change.
Dev repo is an LLM evaluation framework (deepeval). Automation repos are Java Selenium/RestAssured/Appium.
Pick ONLY from the candidate list. Prefer a small high-signal set (3–10). Explain briefly.`,
      responseFormat: llmSchema,
    });
    const res = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            `Dev change (${change.repo} ${change.refLabel}):\n` +
            change.files
              .slice(0, 20)
              .map(
                (f) =>
                  `- ${f.filename} (+${f.additions}/-${f.deletions}) ${f.status}`
              )
              .join("\n") +
            `\n\nCandidates:\n` +
            candidates
              .slice(0, 40)
              .map(
                (c) =>
                  `- ${c.name} | ${c.repo} | ${c.path} | score=${c.score}`
              )
              .join("\n"),
        },
      ],
    });
    return res.structuredResponse as z.infer<typeof llmSchema>;
  } catch (e) {
    console.warn(
      "[impact] LLM refine skipped:",
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

/**
 * Main entry: fetch deepeval change → catalog automation tests → select + run commands.
 */
export async function selectTestsForDevChange(opts?: {
  prOrUrl?: string;
  maxTests?: number;
  syncDocs?: boolean;
}): Promise<ImpactSelectionResult> {
  const maxTests = opts?.maxTests ?? 8;
  const change = await fetchDevChangeSet({ prOrUrl: opts?.prOrUrl });
  if (!change.ok) {
    return {
      ok: false,
      message: change.message,
      devRepo: DEV_REPO,
      changeRef: change.refLabel,
      changeUrl: change.htmlUrl,
      riskLevel: "Medium",
      riskAreas: [],
      changedFiles: [],
      selectedTests: [],
      runCommands: [],
      notes: [
        "Could not load dev diff. Public repo should work without token; set GITHUB_TOKEN if rate-limited.",
      ],
    };
  }

  if (opts?.syncDocs !== false) {
    await syncDevChangeToDocs(opts?.prOrUrl);
    await syncAutomationCatalogToDocs();
  }

  let catalog = await buildAutomationCatalog();
  if (!catalog.tests.length) {
    // Retry from disk sync path already attempted
    catalog = await buildAutomationCatalog();
  }

  const areas = detectAreas(change);
  const tags = wantedTags(change);
  const riskLevel = riskFromChange(change, areas);

  const scored: SelectedTest[] = catalog.tests
    .map((t) => {
      const score = scoreTest(t, tags, areas);
      return {
        repo: t.repo,
        name: t.name,
        path: t.path,
        framework: t.framework,
        reason: `Matched tags/areas for ${areas.join(", ")}`,
        priority: (score >= 15
          ? "High"
          : score >= 8
            ? "Medium"
            : "Low") as SelectedTest["priority"],
        url: t.url,
        score,
      };
    })
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score);

  // Drop weak matches (framework-only bonus)
  const strong = scored.filter((t) => t.score >= 5);
  let selected = (strong.length ? strong : scored).slice(0, maxTests);

  // Prefer RestAssured for API/eval changes; UI/mobile only when those areas appear
  if (
    (areas.includes("api") || areas.includes("llm-evaluation")) &&
    !selected.some((s) => s.framework === "restassured")
  ) {
    const api = scored.find((s) => s.framework === "restassured" && s.score >= 5);
    if (api) selected = [...selected.slice(0, maxTests - 1), api];
  }
  if (areas.includes("ui") && !selected.some((s) => s.framework === "selenium")) {
    const ui = scored.find((s) => s.framework === "selenium");
    if (ui) selected = [...selected.slice(0, maxTests - 1), ui];
  }
  if (
    areas.includes("mobile") &&
    !selected.some((s) => s.framework === "appium")
  ) {
    const mob = scored.find((s) => s.framework === "appium");
    if (mob) selected = [...selected.slice(0, maxTests - 1), mob];
  }

  const llm = await refineWithLlm(change, scored.slice(0, 40));
  const notes: string[] = [
    `Dev repo: ${DEV_REPO}`,
    `Automation pool: ${AUTOMATION_REPOS.join(", ")}`,
    `Selection is impact-based (not full suite). Execute commands in your CI/runner.`,
  ];

  if (llm?.picks?.length) {
    const byKey = new Map(
      scored.map((s) => [`${s.repo}::${s.name}`.toLowerCase(), s])
    );
    const refined: SelectedTest[] = [];
    for (const p of llm.picks.slice(0, maxTests)) {
      const hit =
        byKey.get(`${p.repo}::${p.name}`.toLowerCase()) ||
        scored.find(
          (s) => s.name.toLowerCase() === p.name.toLowerCase()
        );
      if (hit) {
        refined.push({
          ...hit,
          reason: p.reason,
          priority: p.priority,
        });
      }
    }
    if (refined.length) selected = refined;
    notes.push(...(llm.notes ?? []));
  }

  selected = selected.slice(0, maxTests);

  return {
    ok: true,
    message: `Selected ${selected.length} automated test(s) for ${change.repo} ${change.refLabel}`,
    devRepo: change.repo,
    changeRef: change.refLabel,
    changeUrl: change.htmlUrl,
    riskLevel: llm?.riskLevel ?? riskLevel,
    riskAreas: llm?.riskAreas?.length ? llm.riskAreas : areas,
    changedFiles: change.files.map((f) => f.filename),
    selectedTests: selected,
    runCommands: buildRunCommands(selected),
    notes,
  };
}
