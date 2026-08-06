/**
 * Jira Test Case Agent — generate test cases for a Jira issue key.
 * Prefers live Jira API → qa-docs/jira/live/<KEY>.md → Qdrant vector chunks.
 */
import { createAgent, initChatModel } from "langchain";
import z from "zod";
import { CHAT_MODEL } from "../config";
import { fetchJiraIssueByKey } from "../connectors/jira";
import { getAtlassianConfig } from "../connectors/atlassianAuth";
import { ensureIngested } from "../ingest";
import { chunksToContext, retrieveForSource } from "../retrieval";

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

const answerSchema = z.object({
  narrative: z.string(),
  docsUsed: z.array(z.string()),
  assumptions: z.array(z.string()),
  keyFindings: z.array(z.string()),
  gaps: z.array(z.string()),
  testCases: z.array(testCaseSchema),
  suggestedAutomationCandidates: z.array(z.string()),
});

export type JiraTestCaseSource = "live" | "disk" | "qdrant" | "none";

export type JiraTestCaseResult = {
  ok: boolean;
  issueKey: string;
  source: JiraTestCaseSource;
  message: string;
  issueUrl?: string;
  answer?: z.infer<typeof answerSchema>;
};

type IssueContext = {
  key: string;
  markdown: string;
  source: Exclude<JiraTestCaseSource, "none">;
  message: string;
  issueUrl?: string;
  docsUsed: string[];
};

async function loadIssueContextFromQdrant(
  issueKey: string
): Promise<IssueContext | null> {
  const key = issueKey.toUpperCase();
  const store = await ensureIngested();
  const chunks = await retrieveForSource(
    store,
    `${key} Jira issue summary description acceptance criteria`,
    "jira",
    { fetchK: 16, topN: 8, rerank: false }
  );

  const keyNeedle = key.toLowerCase();
  const fileNeedle = `${key.toLowerCase()}.md`;
  const matched = chunks.filter((c) => {
    const path = c.sourcePath.toLowerCase();
    const title = c.title.toLowerCase();
    const body = c.content.toLowerCase();
    return (
      path.includes(fileNeedle) ||
      title.includes(keyNeedle) ||
      body.includes(`# ${keyNeedle}`) ||
      body.includes(keyNeedle)
    );
  });

  // Prefer chunks from the issue file itself
  const preferred = matched.filter((c) =>
    c.sourcePath.toLowerCase().includes(fileNeedle)
  );
  const usable = preferred.length ? preferred : matched;
  if (!usable.length) return null;

  const { baseUrl } = getAtlassianConfig();
  const issueUrl = `${baseUrl}/browse/${key}`;
  return {
    key,
    markdown: chunksToContext(usable),
    source: "qdrant",
    message: `Loaded ${key} from vector DB (${usable.length} chunk(s); live/disk unavailable).`,
    issueUrl,
    docsUsed: [
      ...new Set([
        issueUrl,
        "qdrant-vector-store",
        ...usable.map((c) => c.sourcePath || `${c.sourceSystem}/${c.title}`),
      ]),
    ],
  };
}

async function resolveIssueContext(issueKey: string): Promise<IssueContext | null> {
  const fetched = await fetchJiraIssueByKey(issueKey);
  if (fetched.ok && fetched.markdown) {
    const source = fetched.source === "disk" ? "disk" : "live";
    return {
      key: fetched.issue?.key ?? issueKey.toUpperCase(),
      markdown: fetched.markdown,
      source,
      message: fetched.message,
      issueUrl: fetched.issue?.url,
      docsUsed: [
        fetched.issue?.url ?? `jira:${issueKey}`,
        source === "live" ? "jira-live-api" : "jira/live disk",
      ],
    };
  }

  try {
    const fromVector = await loadIssueContextFromQdrant(issueKey);
    if (fromVector) return fromVector;
  } catch (e) {
    console.warn(
      `[jira-tc] Qdrant fallback failed for ${issueKey}:`,
      e instanceof Error ? e.message : e
    );
  }

  return null;
}

export async function generateTestCasesForJiraKey(
  issueKey: string
): Promise<JiraTestCaseResult> {
  const key = issueKey.trim().toUpperCase();
  const ctx = await resolveIssueContext(key);
  if (!ctx) {
    return {
      ok: false,
      issueKey: key,
      source: "none",
      message:
        `Could not load ${key} from live Jira, local qa-docs/jira/live/, or the vector DB. ` +
        `Set JIRA_EMAIL + JIRA_API_TOKEN, or ensure webhook/ingest has indexed this issue.`,
    };
  }

  const model = await initChatModel(CHAT_MODEL, {
    temperature: 0.3,
    maxOutputTokens: 4096,
  });

  const agent = createAgent({
    model,
    tools: [],
    systemPrompt: `You are a senior QA engineer. Generate 8–12 strong test cases from the Jira issue context below.
Use Given/When/Then style steps. Cover positive, negative, boundary, and security where relevant.
Ground every case in the provided context — do not invent unrelated product features.
Fill narrative, docsUsed, assumptions, keyFindings, gaps, testCases, suggestedAutomationCandidates.`,
    responseFormat: answerSchema,
  });

  const synth = await agent.invoke({
    messages: [
      {
        role: "user",
        content:
          `Generate QA test cases for Jira issue ${ctx.key}.\n` +
          `Context source: ${ctx.source}\n\n` +
          `Issue content:\n${ctx.markdown}`,
      },
    ],
  });

  const answer = synth.structuredResponse as z.infer<typeof answerSchema>;
  if (!answer.docsUsed?.length) {
    answer.docsUsed = ctx.docsUsed;
  } else {
    answer.docsUsed = [...new Set([...answer.docsUsed, ...ctx.docsUsed])];
  }

  return {
    ok: true,
    issueKey: ctx.key,
    source: ctx.source,
    message: ctx.message,
    issueUrl: ctx.issueUrl,
    answer,
  };
}

export function extractJiraIssueKey(query: string): string | undefined {
  const m = query.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return m?.[1]?.toUpperCase();
}

export function isJiraTestCaseQuery(query: string): boolean {
  const q = query.toLowerCase();
  const hasKey = /\b[a-z][a-z0-9]+-\d+\b/i.test(query);
  const wantsCases =
    /\btest\s*cases?\b/.test(q) ||
    /\b(generate|write|create|give)\b.*\b(tests?|scenarios?)\b/.test(q) ||
    /\b(tests?|scenarios?)\b.*\b(for|on)\b/.test(q);
  return hasKey && wantsCases;
}
