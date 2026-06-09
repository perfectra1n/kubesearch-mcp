/**
 * All logging goes to stderr. On the stdio transport, stdout is the MCP wire
 * protocol — writing anything else there corrupts the stream.
 *
 * Levels are gated by the LOG_LEVEL env var (debug|info|warn|error, default
 * "info"). The logger stays standalone (no config.ts import) because it's a
 * low-level module imported everywhere and used on both transports.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold(value: string | undefined): number {
  const v = (value ?? "").trim().toLowerCase();
  if (v in ORDER) return ORDER[v as LogLevel];
  return ORDER.info;
}

const threshold = resolveThreshold(process.env.LOG_LEVEL);

function emit(level: LogLevel, args: unknown[]): void {
  if (ORDER[level] < threshold) return;
  console.error(`[kubesearch-mcp] [${level}]`, ...args);
}

type Logger = {
  (...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

/** Default call logs at info level; named methods select a specific level. */
export const log: Logger = Object.assign((...args: unknown[]) => emit("info", args), {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
});
