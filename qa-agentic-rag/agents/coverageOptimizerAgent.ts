/**
 * Coverage Optimizer Agent — risk-based test coverage planning.
 * Historic prod defects + current dev code changes
 * → deep coverage on high-risk areas, smoke/skip on low-risk.
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
  loadDefectRiskProfile,
  syncDefectsToDocs,
  type HistoricDefect,
} from "../connectors/defects";
import {
  fetchDevChangeSet,
  syncDevChangeToDocs,
  type DevChangeSet,
} from "../connectors/devChange";
import {
  selectTestsForDevChange,
  type SelectedTest,
} from "./testSelectionAgent";

export type CoverageLevel = "deep" | "moderate" | "smoke" | "skip";

export type AreaCoveragePlan = {
  area: string;
  riskScore: number;
  defectCount: number;
  touchedByChange: boolean;
  coverageLevel: CoverageLevel;
  budgetSlots: number;
  relatedDefects: string[];
  rationale: string;
};

export type RecommendedCase = {
  id: string;
  title: string;
  area: string;
  priority: "Critical" | "High" | "Medium" | "Low";
  type: string;
  reason: string;
};

export type OptimizeCoverageResult = {
  ok: boolean;
  message: string;
  devRepo: string;
  changeRef: string;
  changeUrl: string;
  overallRisk: "Critical" | "High" | "Medium" | "Low";
  defectSummary: string;
  areaPlans: AreaCoveragePlan[];
  selectedAutomation: SelectedTest[];
  recommendedNewCases: RecommendedCase[];
  runCommands: string[];
  coverageStrategy: string[];
  notes: string[];
};

const DOC_FILE_RE =
  /citation|\.md$|\.cff$|docs?\/|readme|changelog|_version|pyproject\.toml|package\.json|setup\.cfg|license/i;

const CHANGE_AREA_RULES: { pattern: RegExp; areas: string[] }[] = [
  {
    pattern: /\bmetric|evaluate|evaluation|scorer\b/i,
    areas: ["llm-evaluation", "api", "metric"],
  },
  { pattern: /prompt|dataset|golden/i, areas: ["test-data", "dataset", "api"] },
  { pattern: /guard|safety|security|pii|jailbreak/i, areas: ["security", "guard", "api"] },
  {
    pattern: /(^|\/)(auth|login|session)(\/|$)|\boauth\b|\bjwt\b|\bpassword\b/i,
    areas: ["auth", "login", "security"],
  },
  { pattern: /(^|\/)(api|http|client|rest)(\/|_)|\bendpoint\b/i, areas: ["api"] },
  { pattern: /ui|frontend|component|\.tsx?$/i, areas: ["ui"] },
  { pattern: /mobile|android|ios|appium/i, areas: ["mobile"] },
  { pattern: /checkout|cart|coupon|payment/i, areas: ["checkout", "payment"] },
  { pattern: DOC_FILE_RE, areas: ["docs"] },
];

function areasFromChange(change: DevChangeSet): Set<string> {
  const areas = new Set<string>();
  for (const f of change.files) {
    // Don't treat repo folder name "deepeval" alone as evaluation logic change
    const hay = DOC_FILE_RE.test(f.filename)
      ? f.filename
      : `${f.filename}\n${f.patch ?? ""}`;
    for (const rule of CHANGE_AREA_RULES) {
      if (rule.pattern.test(hay)) rule.areas.forEach((a) => areas.add(a));
    }
  }
  return areas;
}

function isDocsOnlyChange(change: DevChangeSet): boolean {
  return (
    change.files.length > 0 &&
    change.files.every((f) => DOC_FILE_RE.test(f.filename))
  );
}

function coverageLevelFor(
  riskScore: number,
  touched: boolean
): { level: CoverageLevel; slots: number } {
  // Primary: invest where THIS change touches historically weak areas
  if (touched) {
    const boosted = riskScore + Math.max(2, riskScore * 0.4);
    if (boosted >= 10) return { level: "deep", slots: 5 };
    if (boosted >= 6) return { level: "deep", slots: 4 };
    if (boosted >= 3) return { level: "moderate", slots: 2 };
    return { level: "smoke", slots: 1 };
  }
  // Untouched: do not deep-test whole product — only tiny smoke for critical hotspots
  if (riskScore >= 12) return { level: "smoke", slots: 1 };
  return { level: "skip", slots: 0 };
}

function overallFromPlans(
  plans: AreaCoveragePlan[]
): OptimizeCoverageResult["overallRisk"] {
  if (plans.some((p) => p.coverageLevel === "deep" && p.riskScore >= 8))
    return "Critical";
  if (plans.some((p) => p.coverageLevel === "deep")) return "High";
  if (plans.some((p) => p.coverageLevel === "moderate")) return "Medium";
  return "Low";
}

function scoreAutomationForArea(
  test: AutomationTestEntry,
  area: string
): number {
  const hay = `${test.name} ${test.path} ${test.tags.join(" ")}`.toLowerCase();
  let score = 0;
  if (hay.includes(area.toLowerCase())) score += 8;
  for (const t of test.tags) {
    if (t.includes(area) || area.includes(t)) score += 4;
  }
  if (area === "api" && test.framework === "restassured") score += 6;
  if (area === "ui" && test.framework === "selenium") score += 6;
  if (area === "mobile" && test.framework === "appium") score += 6;
  if (
    (area === "auth" || area === "login") &&
    /login|auth|lock/.test(hay)
  )
    score += 10;
  if (
    (area === "llm-evaluation" || area === "metric") &&
    test.framework === "restassured"
  )
    score += 5;
  if (area === "security" || area === "guard") {
    if (/security|guard|auth|login/.test(hay)) score += 6;
    if (test.framework === "restassured") score += 3;
  }
  if (test.tags.includes("smoke") && score > 0) score += 1;
  return score;
}

function pickAutomationForPlans(
  catalog: AutomationTestEntry[],
  plans: AreaCoveragePlan[]
): SelectedTest[] {
  const selected: SelectedTest[] = [];
  const used = new Set<string>();

  const ordered = [...plans].sort((a, b) => b.riskScore - a.riskScore);
  for (const plan of ordered) {
    if (plan.budgetSlots <= 0) continue;
    const ranked = catalog
      .map((t) => ({
        t,
        score: scoreAutomationForArea(t, plan.area),
      }))
      .filter((x) => x.score >= 4)
      .sort((a, b) => b.score - a.score);

    let taken = 0;
    for (const { t, score } of ranked) {
      const key = `${t.repo}::${t.name}`;
      if (used.has(key)) continue;
      used.add(key);
      selected.push({
        repo: t.repo,
        name: t.name,
        path: t.path,
        framework: t.framework,
        reason: `Area **${plan.area}** (${plan.coverageLevel}) — historic defects=${plan.defectCount}, changeTouched=${plan.touchedByChange}`,
        priority:
          plan.coverageLevel === "deep"
            ? "High"
            : plan.coverageLevel === "moderate"
              ? "Medium"
              : "Low",
        url: t.url,
        score: score + plan.riskScore,
      });
      taken += 1;
      if (taken >= plan.budgetSlots) break;
    }
  }
  return selected;
}

function recommendCases(
  plans: AreaCoveragePlan[],
  defects: HistoricDefect[]
): RecommendedCase[] {
  const cases: RecommendedCase[] = [];
  let n = 1;
  for (const plan of plans.filter((p) => p.coverageLevel === "deep")) {
    const related = defects.filter((d) =>
      d.areas.some((a) => a === plan.area)
    );
    cases.push({
      id: `OPT-${String(n).padStart(3, "0")}`,
      title: `Deep regression — ${plan.area} happy path after change`,
      area: plan.area,
      priority: plan.riskScore >= 8 ? "Critical" : "High",
      type: "regression",
      reason: `High risk area (score=${plan.riskScore}). ${plan.rationale}`,
    });
    n += 1;
    cases.push({
      id: `OPT-${String(n).padStart(3, "0")}`,
      title: `Negative / edge — ${plan.area} (historic failure modes)`,
      area: plan.area,
      priority: "High",
      type: "negative",
      reason: related.length
        ? `Inspired by ${related
            .slice(0, 3)
            .map((d) => d.key)
            .join(", ")}: ${related[0]?.summary}`
        : `No named defect; still deep-cover ${plan.area} because change touched it with elevated risk.`,
    });
    n += 1;
    if (plan.riskScore >= 8) {
      cases.push({
        id: `OPT-${String(n).padStart(3, "0")}`,
        title: `Security/boundary — ${plan.area}`,
        area: plan.area,
        priority: "Critical",
        type: "security",
        reason: `Critical/high historic severity concentration in ${plan.area}.`,
      });
      n += 1;
    }
  }
  for (const plan of plans.filter((p) => p.coverageLevel === "moderate")) {
    cases.push({
      id: `OPT-${String(n).padStart(3, "0")}`,
      title: `Focused check — ${plan.area}`,
      area: plan.area,
      priority: "Medium",
      type: "positive",
      reason: plan.rationale,
    });
    n += 1;
  }
  for (const plan of plans.filter((p) => p.coverageLevel === "smoke")) {
    cases.push({
      id: `OPT-${String(n).padStart(3, "0")}`,
      title: `Smoke only — ${plan.area}`,
      area: plan.area,
      priority: "Low",
      type: "smoke",
      reason: `Low historic risk — avoid over-testing. ${plan.rationale}`,
    });
    n += 1;
  }
  return cases;
}

function buildRunCommands(
  selected: SelectedTest[],
  docsOnly?: boolean
): string[] {
  if (docsOnly) {
    return [
      `# Docs/version-only change — no Java automation suite\n` +
        `cd <clone ${DEV_REPO}> && python -m pip install -e . && ` +
        `python -c "import deepeval; print(getattr(deepeval, '__version__', 'ok'))"`,
    ];
  }
  const byRepo = new Map<string, string[]>();
  for (const t of selected) {
    const arr = byRepo.get(t.repo) ?? [];
    arr.push(t.name);
    byRepo.set(t.repo, arr);
  }
  const cmds: string[] = [];
  for (const [repo, names] of byRepo) {
    const uniq = [...new Set(names)].slice(0, 15);
    const short = repo.split("/")[1] ?? repo;
    cmds.push(
      `# ${short} (risk-optimized subset)\ncd <clone ${repo}> && mvn test -Dtest=${uniq.join(",")}`
    );
  }
  return cmds;
}

const llmSchema = z.object({
  coverageStrategy: z.array(z.string()),
  notes: z.array(z.string()),
});

async function strategyNotes(
  plans: AreaCoveragePlan[],
  change: DevChangeSet
): Promise<{ coverageStrategy: string[]; notes: string[] }> {
  const fallbackStrategy = [
    "Allocate deep automated + new cases only to high historic-defect × change-touched areas.",
    "Medium areas get 1–2 focused checks.",
    "Low / docs-only areas get smoke or skip — do not run full regression.",
    `Dev change ${change.refLabel}: optimize for signal, not suite size.`,
  ];
  if ((process.env.QA_IMPACT_LLM ?? "true").toLowerCase() === "false") {
    return { coverageStrategy: fallbackStrategy, notes: [] };
  }
  try {
    const model = await initChatModel(LITE_MODEL, {
      temperature: 0,
      maxOutputTokens: 512,
    });
    const agent = createAgent({
      model,
      tools: [],
      systemPrompt:
        "You write short QA coverage strategy bullets for risk-based testing. Be concrete.",
      responseFormat: llmSchema,
    });
    const res = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            `Change files: ${change.files.map((f) => f.filename).join(", ")}\n` +
            `Area plans:\n` +
            plans
              .map(
                (p) =>
                  `- ${p.area}: ${p.coverageLevel}, risk=${p.riskScore}, defects=${p.defectCount}, touched=${p.touchedByChange}`
              )
              .join("\n"),
        },
      ],
    });
    const out = res.structuredResponse as z.infer<typeof llmSchema>;
    return {
      coverageStrategy: out.coverageStrategy?.length
        ? out.coverageStrategy
        : fallbackStrategy,
      notes: out.notes ?? [],
    };
  } catch {
    return { coverageStrategy: fallbackStrategy, notes: [] };
  }
}

/**
 * Main use case: historic defects + current code change → optimized coverage plan.
 */
export async function optimizeTestCoverage(opts?: {
  prOrUrl?: string;
  syncDocs?: boolean;
}): Promise<OptimizeCoverageResult> {
  const change = await fetchDevChangeSet({
    prOrUrl: opts?.prOrUrl,
    fallbackToLatest: true,
  });
  if (!change.ok) {
    return {
      ok: false,
      message: change.message,
      devRepo: DEV_REPO,
      changeRef: change.refLabel,
      changeUrl: change.htmlUrl,
      overallRisk: "Medium",
      defectSummary: "",
      areaPlans: [],
      selectedAutomation: [],
      recommendedNewCases: [],
      runCommands: [],
      coverageStrategy: [],
      notes: [
        "Could not load dev diff from GitHub.",
        "Fix: add GITHUB_TOKEN to .env → https://github.com/settings/tokens (public_repo) → restart Studio.",
        "Or retry without a PR URL to use cached/latest commit if available.",
      ],
    };
  }

  if (opts?.syncDocs !== false) {
    await syncDevChangeToDocs(opts?.prOrUrl);
    await syncAutomationCatalogToDocs();
    await syncDefectsToDocs();
  }

  const profile = await loadDefectRiskProfile();
  const touched = areasFromChange(change);

  // Union of defect areas + touched areas
  const allAreas = new Set<string>([
    ...Object.keys(profile.areaScores),
    ...touched,
  ]);

  const areaPlans: AreaCoveragePlan[] = [];
  for (const area of allAreas) {
    const riskScore = profile.areaScores[area] ?? 0;
    const defectCount = profile.defectCountByArea[area] ?? 0;
    const isTouched = touched.has(area);
    // Ignore untouched zero-history areas entirely
    if (!isTouched && riskScore === 0) continue;
    // Docs-only untouched historic noise: keep but likely skip
    const { level, slots } = coverageLevelFor(riskScore, isTouched);
    const related = profile.defects
      .filter((d) => d.areas.includes(area))
      .slice(0, 5)
      .map((d) => d.key);
    areaPlans.push({
      area,
      riskScore: Math.round(riskScore + (isTouched ? 2 : 0)),
      defectCount,
      touchedByChange: isTouched,
      coverageLevel: level,
      budgetSlots: slots,
      relatedDefects: related,
      rationale: isTouched
        ? `Code change touches ${area}; historic defect weight=${riskScore}.`
        : `Not in this diff; historic defect weight=${riskScore} (monitor only / skip unless deep).`,
    });
  }

  // Docs/version-only diffs → minimize suite (historic DEF-108 lesson)
  if (isDocsOnlyChange(change)) {
    for (const p of areaPlans) {
      if (p.area === "docs") {
        p.coverageLevel = "smoke";
        p.budgetSlots = 1;
        p.touchedByChange = true;
        p.rationale =
          "Docs/version-only change — minimize regression (historic low-value full runs).";
      } else {
        p.coverageLevel = "skip";
        p.budgetSlots = 0;
        p.touchedByChange = false;
        p.rationale = "Skipped: not touched by docs-only change.";
      }
    }
  }

  areaPlans.sort((a, b) => b.riskScore - a.riskScore);

  const docsOnly = isDocsOnlyChange(change);
  let selectedAutomation: SelectedTest[] = [];

  if (!docsOnly) {
    const catalog = await buildAutomationCatalog();
    selectedAutomation = pickAutomationForPlans(catalog.tests, areaPlans);

    // Fallback only for functional changes when catalog mapping is thin
    if (selectedAutomation.length < 2) {
      const impact = await selectTestsForDevChange({
        prOrUrl: opts?.prOrUrl,
        maxTests: 6,
        syncDocs: false,
      });
      selectedAutomation = impact.selectedTests;
    }

    // Cap to budget — do not inflate beyond allocated slots
    const totalBudget = areaPlans.reduce((n, p) => n + p.budgetSlots, 0);
    selectedAutomation = selectedAutomation
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(totalBudget, 0));
  }

  const recommendedNewCases = recommendCases(areaPlans, profile.defects);
  const { coverageStrategy, notes: llmNotes } = await strategyNotes(
    areaPlans,
    change
  );

  const deep = areaPlans.filter((p) => p.coverageLevel === "deep").length;
  const skip = areaPlans.filter((p) => p.coverageLevel === "skip").length;

  return {
    ok: true,
    message: `Optimized coverage for ${change.repo} ${change.refLabel}: ${deep} deep area(s), ${skip} skipped/low-investment area(s)`,
    devRepo: change.repo,
    changeRef: change.refLabel,
    changeUrl: change.htmlUrl,
    overallRisk: docsOnly ? "Low" : overallFromPlans(areaPlans),
    defectSummary: profile.message,
    areaPlans,
    selectedAutomation,
    recommendedNewCases,
    runCommands: buildRunCommands(selectedAutomation, docsOnly),
    coverageStrategy: docsOnly
      ? [
          "Docs/version-only change detected — do not run functional Selenium/RestAssured/Appium suites.",
          "Limit validation to package metadata / import smoke and doc consistency.",
          ...coverageStrategy.filter((s) => !/full regression/i.test(s)),
        ]
      : coverageStrategy,
    notes: [
      profile.message,
      docsOnly
        ? "No automation suite selected: change is docs/version-only."
        : `Automation repos: ${AUTOMATION_REPOS.join(", ")}`,
      "High-risk areas get more slots; low-risk get smoke/skip.",
      ...(change.fromCache ? ["Dev diff loaded from local cache (GitHub API limited)."] : []),
      ...llmNotes,
    ],
  };
}
