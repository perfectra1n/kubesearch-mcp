/**
 * All logging goes to stderr. On the stdio transport, stdout is the MCP wire
 * protocol — writing anything else there corrupts the stream.
 */
export function log(...args: unknown[]): void {
  console.error("[kubesearch-mcp]", ...args);
}
