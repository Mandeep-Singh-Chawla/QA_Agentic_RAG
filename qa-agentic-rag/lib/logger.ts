/**
 * Structured JSON logger (stdout). Secrets should already be redacted by callers.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel = (
  (process.env.QA_LOG_LEVEL ?? "info").toLowerCase() as LogLevel
);

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= (LEVEL_ORDER[minLevel] ?? 20);
}

function emit(
  level: LogLevel,
  msg: string,
  meta?: Record<string, unknown>
): void {
  if (!enabled(level)) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "qa-agentic-rag",
    msg,
    ...meta,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) =>
    emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) =>
    emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) =>
    emit("error", msg, meta),
};
