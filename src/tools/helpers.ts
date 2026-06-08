import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Success result: human-readable text + machine-readable structuredContent. */
export function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/** Error result (skips outputSchema validation per the MCP spec). */
export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a repo-tool body, turning thrown errors into a clean isError result. */
export async function guarded(fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return fail((err as Error).message);
  }
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Annotation preset for the read-only tools that query the local cached data. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };
