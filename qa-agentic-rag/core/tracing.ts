/**
 * LangSmith tracing bootstrap.
 *
 * LangChain JS looks for LANGCHAIN_TRACING_V2 + LANGCHAIN_API_KEY.
 * This maps your existing LANGSMITH_* env vars so traces show up in LangSmith.
 */
import dotenv from "dotenv";

// Prefer .env over empty shell/IDE placeholders (dotenv skips keys already set,
// even when they are blank — which broke JIRA_API_TOKEN loading).
dotenv.config({ override: true });

const smithKey = (process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY ?? "")
  .trim()
  .replace(/^["']|["']$/g, "");

if (smithKey) {
  process.env.LANGCHAIN_API_KEY = smithKey;
  process.env.LANGSMITH_API_KEY = smithKey;
}

const tracingOn =
  (process.env.LANGSMITH_TRACING ?? process.env.LANGCHAIN_TRACING_V2 ?? "")
    .toString()
    .trim()
    .toLowerCase() === "true";

if (tracingOn && smithKey) {
  process.env.LANGCHAIN_TRACING_V2 = "true";
  process.env.LANGSMITH_TRACING = "true";
  process.env.LANGCHAIN_PROJECT =
    process.env.LANGCHAIN_PROJECT ??
    process.env.LANGSMITH_PROJECT ??
    "qa-agentic-rag";
  console.log(
    `LangSmith tracing ON → project "${process.env.LANGCHAIN_PROJECT}"`
  );
} else if (tracingOn && !smithKey) {
  console.warn(
    "LANGSMITH_TRACING=true but no LANGSMITH_API_KEY — tracing disabled. " +
      "Get a key at https://smith.langchain.com"
  );
}

export const isTracingEnabled = Boolean(tracingOn && smithKey);
