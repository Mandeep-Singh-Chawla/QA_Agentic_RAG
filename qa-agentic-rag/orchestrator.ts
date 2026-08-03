/**
 * Agent Orchestrator (diagram: intent classification → route to specialized agents → LLM reasoning).
 *
 * Supports multiple intents — not only test-case generation:
 * - generate_test_cases
 * - explain_requirements
 * - find_coverage_gaps
 * - api_contract_check
 * - general_qa
 */
import { createAgent, initChatModel } from "langchain";
import z from "zod";
import type { VectorStore } from "@langchain/core/vectorstores";
import {
  CHAT_MODEL,
  LITE_MODEL,
  MAX_SOURCES,
  SOURCES,
  type SourceName,
} from "./config";
import { runSourceAgent, type AgentResult } from "./agents/sourceAgent";
import {
  checkInputGuardrails,
  guardOrchestratorAnswer,
} from "./guardrails";
import {
  formatReposMarkdown,
  listGithubRepos,
} from "./connectors/github";
import {
  formatJiraIssuesMarkdown,
  listJiraIssues,
} from "./connectors/jira";
import { optimizeTestCoverage } from "./impact/optimizeCoverage";
import {
  extractJiraIssueKey,
  generateTestCasesForJiraKey,
  isJiraTestCaseQuery,
} from "./impact/jiraTestCases";
import { selectTestsForDevChange } from "./impact/selectTests";

const routeSchema = z.object({
  intent: z.enum([
    "generate_test_cases",
    "explain_requirements",
    "find_coverage_gaps",
    "api_contract_check",
    "general_qa",
  ]),
  sources: z
    .array(z.enum(["confluence", "jira", "github", "xray"]))
    .describe("Which source agents to call"),
  reasoning: z.string(),
});

const testCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum([
    "positive",
    "negative",
    "boundary",
    "security",
    "ui",
    "regression",
  ]),
  priority: z.enum(["Critical", "High", "Medium", "Low"]),
  preconditions: z.array(z.string()),
  steps: z.array(z.string()),
  expectedResult: z.string(),
  testData: z.string().optional(),
  sourceRefs: z.array(z.string()).optional(),
});

/** Flexible final answer — testCases only required for generate_test_cases intent. */
const answerSchema = z.object({
  narrative: z
    .string()
    .describe("Main answer for the user (always filled)"),
  docsUsed: z.array(z.string()),
  assumptions: z.array(z.string()),
  keyFindings: z
    .array(z.string())
    .describe("Bullet findings from specialist agents"),
  gaps: z
    .array(z.string())
    .describe("Coverage gaps / missing docs / risks (empty if none)"),
  testCases: z
    .array(testCaseSchema)
    .describe("Filled when intent is generate_test_cases; else []"),
  suggestedAutomationCandidates: z
    .array(z.string())
    .describe("Case IDs or areas to automate; else []"),
});

export type OrchestratorResponse = {
  intent: z.infer<typeof routeSchema>["intent"];
  routedTo: SourceName[];
  routeReasoning: string;
  agentResults: AgentResult[];
  answer: z.infer<typeof answerSchema>;
  outputWarnings: string[];
  outputBlocked?: boolean;
  guardrailAuditId?: string;
};

async function classifyAndRoute(query: string) {
  // Lite model for routing to conserve free-tier quota on the main chat model
  const model = await initChatModel(LITE_MODEL, {
    temperature: 0,
    maxOutputTokens: 512,
  });
  const router = createAgent({
    model,
    tools: [],
    systemPrompt:
      `You route enterprise QA knowledge queries.\n` +
      `Intents:\n` +
      `- generate_test_cases: user wants test cases / scenarios\n` +
      `- explain_requirements: explain feature/AC from docs\n` +
      `- find_coverage_gaps: what is untested / missing in Xray vs requirements\n` +
      `- api_contract_check: status codes, API rules, contracts from GitHub notes\n` +
      `- general_qa: other questions about the product docs\n` +
      `Sources: confluence (PRDs), jira (stories), github (API/code), xray (existing tests).\n` +
      `Pick at most ${MAX_SOURCES} most relevant sources. Prefer jira+github for those topics.`,
    responseFormat: routeSchema,
  });

  const res = await router.invoke({
    messages: [{ role: "user", content: query }],
  });
  const route = res.structuredResponse as z.infer<typeof routeSchema>;
  let sources = (route.sources?.length
    ? route.sources
    : ["jira", "github"]) as SourceName[];
  sources = sources.slice(0, MAX_SOURCES);
  return { ...route, sources };
}

function synthesizerPrompt(intent: string): string {
  const base = `You are the final reasoning LLM in an enterprise Agentic RAG system for QA engineering.
Combine specialist agent findings. Ground answers in citations. Do not invent missing product rules — list assumptions.
Always fill narrative, docsUsed, assumptions, keyFindings.`;

  switch (intent) {
    case "generate_test_cases":
      return (
        base +
        `\nIntent=generate_test_cases: produce 8–15 strong testCases (Given/When/Then), priorities, types. Fill suggestedAutomationCandidates.`
      );
    case "find_coverage_gaps":
      return (
        base +
        `\nIntent=find_coverage_gaps: focus narrative + gaps on what requirements exist but lack Xray/tests. testCases may be empty or only suggested missing cases.`
      );
    case "api_contract_check":
      return (
        base +
        `\nIntent=api_contract_check: focus on API endpoints, status codes, contracts. testCases optional (API-level only if useful).`
      );
    case "explain_requirements":
      return (
        base +
        `\nIntent=explain_requirements: clear explanation of requirements/AC. testCases should be [].`
      );
    default:
      return (
        base +
        `\nIntent=general_qa: answer the question from context. testCases usually [].`
      );
  }
}

function isGithubRepoListQuery(query: string): boolean {
  const q = query.toLowerCase();
  const mentionsGithub = /\bgithub\b|\brepos?\b|\brepositories\b/.test(q);
  const wantsList =
    /\b(list|share|show|my|automation|framework|all)\b/.test(q) ||
    /\brepos?\b/.test(q);
  return mentionsGithub && wantsList;
}

function isJiraIssueListQuery(query: string): boolean {
  // Don't treat "test cases for SCRUM-8" as a list-open-tickets query
  if (isJiraTestCaseQuery(query)) return false;
  const q = query.toLowerCase();
  const mentionsJira =
    /\bjira\b|\btickets?\b|\bstories\b|\bbacklog\b|\bscrum-\d+/i.test(q);
  const wantsList =
    /\b(open|list|share|show|my|ids?|issues?|tickets?)\b/.test(q) ||
    (/\bgive\b/.test(q) && /\b(open|ids?|issues?|tickets?)\b/.test(q));
  return mentionsJira && wantsList;
}

function isOptimizeCoverageQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /\boptim(al|ize|ising|izing)?\b.*\b(test|coverage)\b/.test(q) ||
    /\b(test|coverage)\b.*\boptim/.test(q) ||
    /\b(historic|historical|past|prod)\b.*\b(defect|bug|issue)/.test(q) ||
    /\b(defect|bug)\b.*\b(history|historic|prod)/.test(q) ||
    /\b(high\s*risk|low\s*risk)\b.*\b(coverage|test)/.test(q) ||
    /\b(coverage)\b.*\b(high\s*risk|low\s*risk|risk)\b/.test(q) ||
    /\bless coverage\b/.test(q) ||
    /\brisk[- ]based\b.*\bcoverage\b/.test(q)
  );
}

function isDevImpactQuery(query: string): boolean {
  const q = query.toLowerCase();
  if (isOptimizeCoverageQuery(query)) return false;
  return (
    /\bdeepeval\b/.test(q) ||
    /\brisk[- ]based\b/.test(q) ||
    /\b(selective|selected)\b.*\b(test|regression)\b/.test(q) ||
    /\b(test|regression)\b.*\b(selective|selected|impact)\b/.test(q) ||
    (/\b(pr|pull request|code change|diff|commit)\b/.test(q) &&
      /\b(test|regression|automat)/.test(q))
  );
}

function extractPrRef(query: string): string | undefined {
  const url = query.match(/https?:\/\/github\.com\/[^\s]+\/pull\/\d+/i);
  if (url) return url[0];
  const num = query.match(/\bpr\s*#?\s*(\d+)\b/i);
  if (num) return num[1];
  return undefined;
}

export async function runOrchestrator(
  store: VectorStore,
  query: string
): Promise<OrchestratorResponse> {
  const input = checkInputGuardrails(query, { entrypoint: "orchestrator" });
  if (!input.ok) {
    return guardOrchestratorAnswer(
      {
        intent: "general_qa",
        routedTo: [],
        routeReasoning: "Blocked by input guardrails",
        agentResults: [],
        answer: {
          narrative: input.reason ?? "Blocked by input guardrails",
          docsUsed: [],
          assumptions: [],
          keyFindings: [],
          gaps: [input.reason ?? "input_blocked"],
          testCases: [],
          suggestedAutomationCandidates: [],
        },
        outputWarnings: input.warnings,
        outputBlocked: true,
        guardrailAuditId: input.auditId,
      },
      { entrypoint: "orchestrator" }
    );
  }

  return guardOrchestratorAnswer(
    await runOrchestratorCore(store, input.sanitizedQuery),
    { entrypoint: "orchestrator" }
  );
}

async function runOrchestratorCore(
  store: VectorStore,
  query: string
): Promise<OrchestratorResponse> {
  // Fast path: test cases for a specific Jira key (live API or disk)
  if (isJiraTestCaseQuery(query)) {
    const key = extractJiraIssueKey(query);
    if (!key) {
      return {
        intent: "generate_test_cases",
        routedTo: ["jira"],
        routeReasoning: "Jira test-case request missing issue key",
        agentResults: [],
        answer: {
          narrative:
            "Please include a Jira issue key (e.g. SCRUM-8) so I can fetch the ticket and generate test cases.",
          docsUsed: [],
          assumptions: [],
          keyFindings: [],
          gaps: ["No Jira issue key found in the question."],
          testCases: [],
          suggestedAutomationCandidates: [],
        },
        outputWarnings: [],
      };
    }

    const result = await generateTestCasesForJiraKey(key);
    if (!result.ok || !result.answer) {
      return {
        intent: "generate_test_cases",
        routedTo: ["jira"],
        routeReasoning: `Live/disk fetch failed for ${key}`,
        agentResults: [
          {
            agent: "jira",
            summary: result.message,
            chunks: [],
            citations: [],
          },
        ],
        answer: {
          narrative: result.message,
          docsUsed: [],
          assumptions: [],
          keyFindings: [],
          gaps: [result.message],
          testCases: [],
          suggestedAutomationCandidates: [],
        },
        outputWarnings: [],
      };
    }

    return {
      intent: "generate_test_cases",
      routedTo: ["jira"],
      routeReasoning: `Test cases from Jira ${key} (${result.source})`,
      agentResults: [
        {
          agent: "jira",
          summary: result.message,
          chunks: [],
          citations: result.issueUrl ? [result.issueUrl] : [`jira/${key}`],
        },
      ],
      answer: result.answer,
      outputWarnings: [],
    };
  }

  // Fast path: historic defects + code change → optimized coverage budget
  if (isOptimizeCoverageQuery(query)) {
    const opt = await optimizeTestCoverage({
      prOrUrl: extractPrRef(query),
      syncDocs: true,
    });
    const narrative = opt.ok
      ? [
          `**Optimized test coverage** for \`${opt.devRepo}\` (${opt.changeRef})`,
          `Overall risk: **${opt.overallRisk}**`,
          `Change: ${opt.changeUrl}`,
          `Defects: ${opt.defectSummary}`,
          ``,
          `### Area coverage plan (deep = more tests, skip/smoke = less)`,
          ...opt.areaPlans.map(
            (p) =>
              `- **${p.area}** → \`${p.coverageLevel}\` (risk=${p.riskScore}, defects=${p.defectCount}, touched=${p.touchedByChange})` +
              (p.relatedDefects.length
                ? ` — ${p.relatedDefects.join(", ")}`
                : "") +
              `\n  ${p.rationale}`
          ),
          ``,
          `### Strategy`,
          ...opt.coverageStrategy.map((s) => `- ${s}`),
          ``,
          `### Selected automation (budgeted)`,
          ...(opt.selectedAutomation.length
            ? opt.selectedAutomation.map(
                (t) =>
                  `- **${t.name}** (${t.framework}) — ${t.repo}\n  - ${t.reason}`
              )
            : ["- _(none mapped — add tagged tests in automation repos)_"]),
          ``,
          `### Recommended new / manual cases`,
          ...opt.recommendedNewCases.map(
            (c) =>
              `- **${c.id}** [${c.priority}/${c.type}] ${c.title}\n  - ${c.reason}`
          ),
          ``,
          `### Run commands`,
          "```bash",
          ...opt.runCommands,
          "```",
        ].join("\n")
      : opt.message;

    return {
      intent: "generate_test_cases",
      routedTo: ["jira", "github"],
      routeReasoning:
        "Historic defects + dev diff → risk-optimized coverage (bypass generic RAG)",
      agentResults: [
        {
          agent: "jira",
          summary: opt.defectSummary,
          chunks: [],
          citations: ["jira/live/historic-defects.md", "jira/defects/"],
        },
        {
          agent: "github",
          summary: narrative,
          chunks: [],
          citations: [
            opt.changeUrl,
            "github/live/automation-test-catalog.md",
          ],
        },
      ],
      answer: {
        narrative,
        docsUsed: [
          opt.changeUrl,
          "jira/live/historic-defects.md",
          "github/live/automation-test-catalog.md",
        ],
        assumptions: [],
        keyFindings: [
          `Overall risk: ${opt.overallRisk}`,
          ...opt.areaPlans
            .filter((p) => p.coverageLevel !== "skip")
            .slice(0, 8)
            .map(
              (p) =>
                `${p.area}: ${p.coverageLevel} (risk=${p.riskScore}, defects=${p.defectCount})`
            ),
        ],
        gaps: opt.ok
          ? opt.areaPlans
              .filter((p) => p.coverageLevel === "deep" && !opt.selectedAutomation.some((t) => t.reason.includes(p.area)))
              .map(
                (p) =>
                  `No strong automation mapped for deep area "${p.area}" — use recommended new cases.`
              )
          : [opt.message],
        testCases: opt.recommendedNewCases.map((c) => ({
          id: c.id,
          title: c.title,
          type: (["positive", "negative", "boundary", "security", "ui", "regression"].includes(
            c.type
          )
            ? c.type
            : c.type === "smoke"
              ? "positive"
              : "regression") as
            | "positive"
            | "negative"
            | "boundary"
            | "security"
            | "ui"
            | "regression",
          priority: c.priority,
          preconditions: [`Area: ${c.area}`],
          steps: [
            `Focus coverage on ${c.area}`,
            c.reason,
            "Execute against build that includes the developer change",
          ],
          expectedResult: `Risk for ${c.area} is validated without over-testing low-risk areas`,
          sourceRefs: ["historic-defects", "dev-change"],
        })),
        suggestedAutomationCandidates: opt.selectedAutomation.map((t) => t.name),
      },
      outputWarnings: [],
    };
  }

  // Fast path: deepeval code-change → select automation tests
  if (isDevImpactQuery(query)) {
    const impact = await selectTestsForDevChange({
      prOrUrl: extractPrRef(query),
      maxTests: 8,
      syncDocs: true,
    });
    const narrative = impact.ok
      ? [
          `**Risk-based selection** for \`${impact.devRepo}\` (${impact.changeRef})`,
          `Risk: **${impact.riskLevel}** — areas: ${impact.riskAreas.join(", ") || "n/a"}`,
          `Change: ${impact.changeUrl}`,
          ``,
          `### Selected automated tests`,
          ...impact.selectedTests.map(
            (t) =>
              `- **${t.name}** (${t.framework}) — ${t.repo}\n  - ${t.reason}\n  - ${t.url}`
          ),
          ``,
          `### Run commands`,
          "```bash",
          ...impact.runCommands,
          "```",
          ``,
          ...impact.notes.map((n) => `- ${n}`),
        ].join("\n")
      : impact.message;

    return {
      intent: "general_qa",
      routedTo: ["github"],
      routeReasoning:
        "Dev change impact → automation test selection (bypassed generic RAG)",
      agentResults: [
        {
          agent: "github",
          summary: narrative,
          chunks: [],
          citations: [
            impact.changeUrl,
            "github/live/automation-test-catalog.md",
            "github/live/dev-deepeval/latest-change.md",
          ],
        },
      ],
      answer: {
        narrative,
        docsUsed: [
          impact.changeUrl,
          "github/live/automation-test-catalog.md",
          ...impact.changedFiles.slice(0, 10),
        ],
        assumptions: [],
        keyFindings: [
          `Risk: ${impact.riskLevel}`,
          ...impact.selectedTests.map((t) => `${t.name} @ ${t.repo}`),
        ],
        gaps: impact.ok
          ? []
          : [impact.message],
        testCases: [],
        suggestedAutomationCandidates: impact.selectedTests.map((t) => t.name),
      },
      outputWarnings: [],
    };
  }

  // Fast path: list open Jira issues via live API (never use sample LOGIN-241.md)
  if (isJiraIssueListQuery(query)) {
    const openOnly = !/\b(all|closed|done|resolved)\b/i.test(query);
    const listed = await listJiraIssues({ openOnly, limit: 50 });
    const md = formatJiraIssuesMarkdown(
      listed.projectKey,
      listed.baseUrl,
      listed.issues,
      openOnly ? "Open Jira issues" : "Jira issues"
    );
    return {
      intent: "general_qa",
      routedTo: ["jira"],
      routeReasoning: "Live Jira API issue listing (bypassed vector RAG)",
      agentResults: [
        {
          agent: "jira",
          summary: md,
          chunks: [],
          citations: [
            `${listed.baseUrl}/jira/software/projects/${listed.projectKey}/boards/1/backlog`,
            "jira/live/open-issues.md",
          ],
        },
      ],
      answer: {
        narrative: listed.ok
          ? `Open Jira issue IDs in **${listed.projectKey}** (${listed.baseUrl}):\n\n` +
            (listed.issues.length
              ? listed.issues
                  .map(
                    (i) =>
                      `- **${i.key}** — ${i.summary} (${i.status}, ${i.issuetype}) — ${i.url}`
                  )
                  .join("\n")
              : "_No open issues found._")
          : listed.message,
        docsUsed: [
          `${listed.baseUrl}/rest/api/3/search`,
          `project ${listed.projectKey}`,
        ],
        assumptions: [],
        keyFindings: listed.ok
          ? listed.issues.map((i) => `${i.key}: ${i.summary} [${i.status}]`)
          : [listed.message],
        gaps: listed.ok
          ? []
          : [
              "Live Jira API unavailable. Set JIRA_API_TOKEN in .env (Atlassian API token). Do not trust sample docs like LOGIN-241 for live board status.",
            ],
        testCases: [],
        suggestedAutomationCandidates: [],
      },
      outputWarnings: [],
    };
  }

  // Fast path: list GitHub repos via live API (don't rely on sparse RAG chunks)
  if (isGithubRepoListQuery(query)) {
    const automationOnly =
      /\bautomation\b|\bframework\b|\bqa\b|\bselenium\b|\bappium\b|\btest\b/i.test(
        query
      );
    const listed = await listGithubRepos({
      automationOnly,
      limit: automationOnly ? 20 : 40,
    });
    const md = formatReposMarkdown(
      listed.user,
      listed.repos,
      automationOnly
        ? "Automation / QA framework repositories"
        : "GitHub repositories"
    );
    const names = listed.repos.map((r) => r.name);
    return {
      intent: "general_qa",
      routedTo: ["github"],
      routeReasoning: "Live GitHub API repo listing (bypassed vector RAG)",
      agentResults: [
        {
          agent: "github",
          summary: md,
          chunks: [],
          citations: [
            `github/live/${automationOnly ? "my-automation-repos.md" : "my-repos.md"}`,
            `https://github.com/${listed.user}`,
          ],
        },
      ],
      answer: {
        narrative: listed.ok
          ? `Here are GitHub repositories for **${listed.user}**` +
            (automationOnly ? " (automation/QA-focused filter applied)" : "") +
            `:\n\n` +
            listed.repos
              .map(
                (r) =>
                  `- [${r.name}](${r.html_url})` +
                  (r.description ? ` — ${r.description}` : "") +
                  (r.language ? ` (${r.language})` : "")
              )
              .join("\n")
          : listed.message,
        docsUsed: [
          `https://api.github.com/users/${listed.user}/repos`,
          `github.com/${listed.user}`,
        ],
        assumptions: process.env.GITHUB_TOKEN?.trim()
          ? []
          : [
              "Listed public repos only (no GITHUB_TOKEN). Set GITHUB_TOKEN to include private repos.",
            ],
        keyFindings: names.length
          ? names.slice(0, 12).map((n) => `Repo: ${n}`)
          : [listed.message],
        gaps: listed.ok
          ? []
          : [
              "Could not list repos from GitHub API. Check network or set GITHUB_TOKEN for higher limits/private repos.",
            ],
        testCases: [],
        suggestedAutomationCandidates: [],
      },
      outputWarnings: [],
    };
  }

  const route = await classifyAndRoute(query);
  const targets = route.sources.filter((s) =>
    (SOURCES as readonly string[]).includes(s)
  ) as SourceName[];

  const agentResults: AgentResult[] = [];
  for (const source of targets) {
    agentResults.push(await runSourceAgent(store, source, query));
  }

  const combined = agentResults
    .map(
      (r) =>
        `### ${r.agent.toUpperCase()} agent\nCitations: ${r.citations.join(", ") || "none"}\n${r.summary}`
    )
    .join("\n\n");

  const model = await initChatModel(CHAT_MODEL, {
    temperature: 0.3,
    maxOutputTokens: 4096,
  });

  const synthesizer = createAgent({
    model,
    tools: [],
    systemPrompt: synthesizerPrompt(route.intent),
    responseFormat: answerSchema,
  });

  const synth = await synthesizer.invoke({
    messages: [
      {
        role: "user",
        content:
          `User query:\n${query}\n\n` +
          `Intent: ${route.intent}\n` +
          `Specialist agent findings:\n${combined}`,
      },
    ],
  });

  const answer = synth.structuredResponse as z.infer<typeof answerSchema>;

  return {
    intent: route.intent,
    routedTo: targets,
    routeReasoning: route.reasoning,
    agentResults,
    answer,
    outputWarnings: [],
  };
}
