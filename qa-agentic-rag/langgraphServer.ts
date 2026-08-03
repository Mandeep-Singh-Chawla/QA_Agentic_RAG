/**
 * LangGraph / LangSmith Studio entry for qa-agentic-rag.
 *
 * Selected in Studio as graph: "qa_agentic"
 * Start:  npx @langchain/langgraph-cli dev
 * Open the Studio URL printed in the terminal (usually):
 *   https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024
 */
import "./tracing";
import { createAgent, tool } from "langchain";
import z from "zod";
import { ensureIngested } from "./ingest";
import { runOrchestrator } from "./orchestrator";
import { DEV_REPO, LITE_MODEL } from "./config";
import {
  formatReposMarkdown,
  listGithubRepos,
} from "./connectors/github";
import {
  formatJiraIssuesMarkdown,
  listJiraIssues,
} from "./connectors/jira";
import { optimizeTestCoverage } from "./impact/optimizeCoverage";
import { generateTestCasesForJiraKey } from "./impact/jiraTestCases";
import { selectTestsForDevChange } from "./impact/selectTests";
import { guardToolInput, redactDeep } from "./guardrails";

function blockedTool(input: ReturnType<typeof guardToolInput>) {
  return JSON.stringify(
    {
      ok: false,
      blocked: true,
      error: input.reason,
      auditId: input.auditId,
      warnings: input.warnings,
    },
    null,
    2
  );
}

const listJiraIssuesTool = tool(
  async ({ openOnly }) => {
    const gate = guardToolInput(
      openOnly === false ? "list all jira issues" : "list open jira issues",
      "list_jira_issues"
    );
    if (!gate.ok) return blockedTool(gate);

    const listed = await listJiraIssues({
      openOnly: openOnly ?? true,
      limit: 50,
    });
    return JSON.stringify(
      redactDeep({
        ok: listed.ok,
        projectKey: listed.projectKey,
        baseUrl: listed.baseUrl,
        message: listed.message,
        count: listed.issues.length,
        issues: listed.issues.map((i) => ({
          key: i.key,
          summary: i.summary,
          status: i.status,
          type: i.issuetype,
          priority: i.priority,
          url: i.url,
        })),
        markdown: formatJiraIssuesMarkdown(
          listed.projectKey,
          listed.baseUrl,
          listed.issues,
          openOnly === false ? "Jira issues" : "Open Jira issues"
        ),
        guardrailAuditId: gate.auditId,
      }),
      null,
      2
    );
  },
  {
    name: "list_jira_issues",
    description:
      "List live Jira issues from project SCRUM (mandeepsingh1986.atlassian.net). Use when the user asks for open Jira IDs, tickets, backlog items, or stories. Requires JIRA_API_TOKEN. Never invent LOGIN-* sample IDs.",
    schema: z.object({
      openOnly: z
        .boolean()
        .optional()
        .describe("If true (default), only issues not in Done statusCategory."),
    }),
  }
);

const listGithubReposTool = tool(
  async ({ automationOnly }) => {
    const gate = guardToolInput(
      automationOnly === false
        ? "list github repos"
        : "list github automation qa framework repos",
      "list_github_repos"
    );
    if (!gate.ok) return blockedTool(gate);

    const listed = await listGithubRepos({
      automationOnly: automationOnly ?? true,
      limit: 40,
    });
    return JSON.stringify(
      redactDeep({
        ok: listed.ok,
        user: listed.user,
        message: listed.message,
        count: listed.repos.length,
        repos: listed.repos.map((r) => ({
          name: r.name,
          url: r.html_url,
          description: r.description,
          language: r.language,
          topics: r.topics,
          stars: r.stargazers_count,
          private: r.private,
        })),
        markdown: formatReposMarkdown(
          listed.user,
          listed.repos,
          automationOnly
            ? "Automation / QA framework repositories"
            : "GitHub repositories"
        ),
        guardrailAuditId: gate.auditId,
      }),
      null,
      2
    );
  },
  {
    name: "list_github_repos",
    description:
      "List live GitHub repositories for the configured user (default Mandeep-Singh-Chawla). Use when the user asks to share/list/show their GitHub repos, automation frameworks, or repositories. Works without GITHUB_TOKEN for public repos.",
    schema: z.object({
      automationOnly: z
        .boolean()
        .optional()
        .describe(
          "If true (default), prefer automation/QA/framework repos. Set false to list all repos."
        ),
    }),
  }
);

const generateTestsForJiraTool = tool(
  async ({ issueKey }) => {
    const gate = guardToolInput(
      `give me test cases for jira id ${issueKey}`,
      "generate_tests_for_jira_issue"
    );
    if (!gate.ok) return blockedTool(gate);

    const result = await generateTestCasesForJiraKey(issueKey);
    return JSON.stringify(redactDeep({ ...result, guardrailAuditId: gate.auditId }), null, 2);
  },
  {
    name: "generate_tests_for_jira_issue",
    description:
      "Fetch a specific Jira issue by key (e.g. SCRUM-8) via live API (or local live index / Qdrant fallback) and generate QA test cases for it. Use when the user asks for test cases / scenarios for a Jira id/key.",
    schema: z.object({
      issueKey: z
        .string()
        .describe("Jira issue key such as SCRUM-8 or PROJECT-123"),
    }),
  }
);

const optimizeTestCoverageTool = tool(
  async ({ prOrUrl }) => {
    const gate = guardToolInput(
      prOrUrl
        ? `optimize test coverage for historic defects and code change ${prOrUrl}`
        : "optimize test coverage for historic defects and code change",
      "optimize_test_coverage"
    );
    if (!gate.ok) return blockedTool(gate);

    const result = await optimizeTestCoverage({
      prOrUrl: prOrUrl || undefined,
      syncDocs: true,
    });
    try {
      await ensureIngested();
    } catch {
      /* optional */
    }
    return JSON.stringify(redactDeep({ ...result, guardrailAuditId: gate.auditId }), null, 2);
  },
  {
    name: "optimize_test_coverage",
    description: `Optimal risk-based test coverage using (1) historic prod/Jira defects and (2) current code changes in ${DEV_REPO}. Allocates deep coverage to high-risk areas and smoke/skip to low-risk areas. Returns area plan, selected automation, recommended new cases, and run commands. Prefer this for "optimize coverage", "high risk more tests", "historic defects + code change".`,
    schema: z.object({
      prOrUrl: z
        .string()
        .optional()
        .describe("Optional PR number or GitHub PR URL for the dev change."),
    }),
  }
);

const selectTestsForDevChangeTool = tool(
  async ({ prOrUrl, maxTests }) => {
    const gate = guardToolInput(
      prOrUrl
        ? `select automated tests for github pr ${prOrUrl}`
        : "select automated tests for latest github code change",
      "select_tests_for_dev_change"
    );
    if (!gate.ok) return blockedTool(gate);

    const result = await selectTestsForDevChange({
      prOrUrl: prOrUrl || undefined,
      maxTests: maxTests ?? 8,
      syncDocs: true,
    });
    try {
      await ensureIngested();
    } catch {
      /* ingest optional for selection answer */
    }
    return JSON.stringify(redactDeep({ ...result, guardrailAuditId: gate.auditId }), null, 2);
  },
  {
    name: "select_tests_for_dev_change",
    description: `Lighter change-impact selection for ${DEV_REPO} without full historic-defect budgeting. Use for simple "which tests for this PR" questions. For optimized high/low risk coverage, prefer optimize_test_coverage.`,
    schema: z.object({
      prOrUrl: z
        .string()
        .optional()
        .describe(
          "PR number or full GitHub PR URL. If omitted, uses the latest commit(s) on the deepeval default branch."
        ),
      maxTests: z
        .number()
        .optional()
        .describe("Max automated tests to select (default 8)"),
    }),
  }
);

const askEnterpriseQa = tool(
  async ({ question }) => {
    const gate = guardToolInput(question, "ask_enterprise_qa");
    if (!gate.ok) return blockedTool(gate);

    const store = await ensureIngested();
    const result = await runOrchestrator(store, gate.sanitizedQuery);
    return JSON.stringify(
      redactDeep({
        intent: result.intent,
        routedTo: result.routedTo,
        routeReasoning: result.routeReasoning,
        narrative: result.answer.narrative,
        keyFindings: result.answer.keyFindings,
        gaps: result.answer.gaps,
        docsUsed: result.answer.docsUsed,
        assumptions: result.answer.assumptions,
        testCases: result.answer.testCases,
        suggestedAutomationCandidates:
          result.answer.suggestedAutomationCandidates,
        agentCitations: result.agentResults.map((a) => ({
          agent: a.agent,
          citations: a.citations,
        })),
        outputWarnings: result.outputWarnings,
        outputBlocked: result.outputBlocked,
        guardrailAuditId: result.guardrailAuditId ?? gate.auditId,
      }),
      null,
      2
    );
  },
  {
    name: "ask_enterprise_qa",
    description:
      "Answer QA engineering questions using live/synced Jira, GitHub, Confluence, and Xray knowledge. Prefer optimize_test_coverage for historic-defect + code-change coverage optimization. Input/output guardrails apply.",
    schema: z.object({
      question: z.string().describe("The user's full question"),
    }),
  }
);

const agent = createAgent({
  // Lite model for the Studio chat wrapper (orchestrator uses CHAT_MODEL internally)
  model: LITE_MODEL,
  tools: [
    generateTestsForJiraTool,
    optimizeTestCoverageTool,
    selectTestsForDevChangeTool,
    listJiraIssuesTool,
    listGithubReposTool,
    askEnterpriseQa,
  ],
  systemPrompt: `You are an enterprise QA assistant backed by Agentic RAG across Jira, GitHub, Confluence, and Xray.

Dev application repo: ${DEV_REPO}
QA automation repos: Mandeep-Singh-Chawla Selenium / RestAssured / Appium frameworks.

All tools enforce input guardrails (QA allowlist, injection block, secret/PII redaction).
If a tool returns blocked=true, tell the user the request was blocked and do not invent an answer.

Tool choice:
- Test cases / scenarios for a specific Jira key (e.g. SCRUM-8) → generate_tests_for_jira_issue FIRST. Pass the issue key. Then present the returned testCases clearly.
- Optimize coverage / historic defects + code change → optimize_test_coverage.
- Simple "which automated tests for this PR/diff" → select_tests_for_dev_change.
- Open/list Jira IDs (not test-case gen) → list_jira_issues.
- List GitHub automation repos → list_github_repos.
- Other requirements / gaps / API contracts → ask_enterprise_qa.

generate_tests_for_jira_issue order: live Jira → local qa-docs/jira/live → Qdrant chunks.
If it fails entirely, tell the user to set JIRA_EMAIL + JIRA_API_TOKEN and/or ensure webhook/ingest indexed the issue.
If outputBlocked is true, explain the grounding/guardrail failure — never invent ticket details.`,
});

export const graph = agent;
