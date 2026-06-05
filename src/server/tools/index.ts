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
import { registerFindDeadCodeTool } from './find_dead_code'
import { registerGetUntestedSymbolsTool } from './get_untested_symbols'
import { registerGetSymbolImportanceTool } from './get_symbol_importance'
import { registerGetDependencyCyclesTool } from './get_dependency_cycles'
import { registerGetCouplingMetricsTool } from './get_coupling_metrics'
import { registerAuditAgentConfigTool } from './audit_agent_config'

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

  // Type and pattern analysis
  registerResolveTypeTool(server)
  registerFindSimilarPatternsTool(server)

  // Analytical / quality tools
  registerFindDeadCodeTool(server)
  registerGetUntestedSymbolsTool(server)
  registerGetSymbolImportanceTool(server)
  registerGetDependencyCyclesTool(server)
  registerGetCouplingMetricsTool(server)
  registerAuditAgentConfigTool(server)
}
