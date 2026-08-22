import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { registerSearchCodebaseTool } from './search_codebase'
import { registerReadCodeTool } from './read_code'
import { registerInspectSymbolTool } from './inspect_symbol'
import { registerTraceCodeGraphTool } from './trace_code_graph'
import { registerAnalyzeChangeImpactTool } from './analyze_change_impact'
import { registerExploreArchitectureTool } from './explore_architecture'
import { registerAnalyzeQualityTool } from './analyze_quality'
import { registerInspectImportsTool } from './inspect_imports'
import { registerAuditIndexTool } from './audit_index'

export type ToolResult = ReturnType<ToolCallback<undefined | ZodRawShapeCompat>>
/** Registers essential commands and tools for managing and interacting with the Minecraft Pocket Edition server. */
export function registerTools(server: McpServer) {
  registerSearchCodebaseTool(server)
  registerReadCodeTool(server)
  registerInspectSymbolTool(server)
  registerTraceCodeGraphTool(server)
  registerAnalyzeChangeImpactTool(server)
  registerExploreArchitectureTool(server)
  registerAnalyzeQualityTool(server)
  registerInspectImportsTool(server)
  registerAuditIndexTool(server)
}
