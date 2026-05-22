import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerSearchSymbolsTool } from './search_symbols'
import { registerGetFileDetailsTool } from './get_file_details'
import { registerListFilesTool } from './list_files'
import { registerGetDefinitionTool } from './get_definition'
import { registerGetBlastRadiusTool } from './get_blast_radius'
import { registerTraceCallGraphTool } from './trace_call_graph'
import { registerFindSymbolReferencesTool } from './find_symbol_references'
import { registerGetCodebaseMapTool } from './get_codebase_map'
import { registerFindRelatedTestsTool } from './find_related_tests'
import { registerResolveTypeTool } from './resolve_type'
import { registerTraceDataFlowTool } from './trace_data_flow'
import { registerFindSimilarPatternsTool } from './find_similar_patterns'
import { registerGetEntryPointsTool } from './get_entry_points'
import { registerGetHierarchyTool } from './get_hierarchy'

/** Registers all MCP tools on the server. */
export function registerTools(server: McpServer) {
  // Core navigation
  registerSearchSymbolsTool(server)
  registerGetFileDetailsTool(server)
  registerGetDefinitionTool(server)
  registerListFilesTool(server)

  // Graph traversal
  registerTraceCallGraphTool(server)
  registerGetBlastRadiusTool(server)
  registerFindSymbolReferencesTool(server)
  registerTraceDataFlowTool(server)

  // Codebase structure
  registerGetCodebaseMapTool(server)
  registerGetEntryPointsTool(server)
  registerFindRelatedTestsTool(server)
  registerGetHierarchyTool(server)

  // Type and pattern analysis
  registerResolveTypeTool(server)
  registerFindSimilarPatternsTool(server)
}
