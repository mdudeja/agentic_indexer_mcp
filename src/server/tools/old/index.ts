import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerSearchSymbolsTool } from './search_symbols'
import { registerSemanticSearchSymbolsTool } from './semantic_search_symbols'
import { registerGetTypeAtLocationTool } from './get_type_at_location'
import { registerReadFileSnippetTool } from './read_file_snippet'
import { registerGetSymbolHistoryTool } from './get_symbol_history'
import { registerTraceErrorFlowTool } from './trace_error_flow'
import { registerGetRequiredEnvVarsTool } from './get_required_env_vars'
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
import { registerExploreCodebaseTool } from './explore_codebase'
import { registerGetTokenSavingsTool } from './get_token_savings'
import { registerGetImportsForFileTool } from './get_imports_for_file'
import { registerGetImportByIdTool } from './get_import_by_id'

/** Registers all MCP tools on the server. */
export function registerTools(server: McpServer) {
  // Core navigation
  registerSearchSymbolsTool(server)
  registerSemanticSearchSymbolsTool(server)
  registerGetTypeAtLocationTool(server)
  registerReadFileSnippetTool(server)
  registerGetSymbolHistoryTool(server)
  registerTraceErrorFlowTool(server)
  registerGetRequiredEnvVarsTool(server)
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
  registerGetImportsForFileTool(server)
  registerGetImportByIdTool(server)

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
  registerExploreCodebaseTool(server)

  // Analytics
  registerGetTokenSavingsTool(server)
}
