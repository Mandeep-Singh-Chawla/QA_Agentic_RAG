/**
 * CLI entry for Case 2 without starting the HTTP server.
 *
 *   npx tsx qa-agentic-rag/cli.ts "Generate login lockout test cases"
 *   npx tsx qa-agentic-rag/cli.ts "What coverage gaps exist for login?"
 *
 * Do NOT run core/orchestrator.ts directly — this file (or server.ts) is the entrypoint.
 */
import "./core/tracing";
import { ensureIngested } from "./rag/ingest";
import { checkInputGuardrails, redactDeep } from "./core/guardrails";
import { runOrchestrator } from "./core/orchestrator";

const query =
  process.argv.slice(2).join(" ").trim() ||
  "Generate QA test cases for login lockout after failed attempts";

const input = checkInputGuardrails(query, { entrypoint: "cli" });
if (!input.ok) {
  console.error("Input blocked:", input.reason);
  console.error("auditId:", input.auditId);
  process.exit(1);
}
if (input.warnings.length) {
  console.warn("Input warnings:", input.warnings);
}

console.log("Ingesting qa-docs ...");
const store = await ensureIngested();
console.log("Running orchestrator ...\n");
const result = redactDeep(await runOrchestrator(store, input.sanitizedQuery));

console.log("Intent:", result.intent);
console.log("Routed to:", result.routedTo.join(", "));
console.log("Reason:", result.routeReasoning);
if (result.outputBlocked) {
  console.error("\nOUTPUT BLOCKED by guardrails");
}
console.log("\n--- Agent summaries ---");
for (const a of result.agentResults) {
  console.log(`\n[${a.agent}] citations=${a.citations.join(" | ") || "none"}`);
  console.log(a.summary.slice(0, 500));
}
console.log("\n--- Narrative ---");
console.log(result.answer.narrative);
if (result.answer.keyFindings?.length) {
  console.log("\nKey findings:", result.answer.keyFindings);
}
if (result.answer.gaps?.length) {
  console.log("Gaps:", result.answer.gaps);
}
if (result.answer.testCases?.length) {
  console.log(`\nTest cases: ${result.answer.testCases.length}`);
  console.log(JSON.stringify(result.answer.testCases, null, 2));
}
if (result.outputWarnings.length) {
  console.log("\nOutput warnings:", result.outputWarnings);
}
if (result.guardrailAuditId) {
  console.log("\nGuardrail audit:", result.guardrailAuditId);
}
if (result.outputBlocked) process.exit(2);
