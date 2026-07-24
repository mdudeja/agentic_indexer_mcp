import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'

export type ToolResult = ReturnType<ToolCallback<undefined | ZodRawShapeCompat>>
export function registerTools(server: McpServer) {}
