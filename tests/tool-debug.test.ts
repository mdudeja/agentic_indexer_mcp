import { describe, expect, beforeAll, test } from 'bun:test'
import { registerSearchSymbolsTool } from '../src/server/tools/search_symbols'
import { registerSemanticSearchSymbolsTool } from '../src/server/tools/semantic_search_symbols'
import { registerGetTypeAtLocationTool } from '../src/server/tools/get_type_at_location'
import { registerReadFileSnippetTool } from '../src/server/tools/read_file_snippet'
import { registerGetSymbolHistoryTool } from '../src/server/tools/get_symbol_history'
import { registerTraceErrorFlowTool } from '../src/server/tools/trace_error_flow'
import { registerGetRequiredEnvVarsTool } from '../src/server/tools/get_required_env_vars'
import { registerGetFileDetailsTool } from '../src/server/tools/get_file_details'
import { registerGetDefinitionTool } from '../src/server/tools/get_definition'
import { registerListFilesTool } from '../src/server/tools/list_files'
import { registerTraceCallGraphTool } from '../src/server/tools/trace_call_graph'
import { registerGetBlastRadiusTool } from '../src/server/tools/get_blast_radius'
import { registerFindSymbolReferencesTool } from '../src/server/tools/find_symbol_references'
import { registerTraceDataFlowTool } from '../src/server/tools/trace_data_flow'
import { registerGetCodebaseMapTool } from '../src/server/tools/get_codebase_map'
import { registerGetEntryPointsTool } from '../src/server/tools/get_entry_points'
import { registerFindRelatedTestsTool } from '../src/server/tools/find_related_tests'
import { registerGetImportsForFileTool } from '../src/server/tools/get_imports_for_file'
import { registerGetImportByIdTool } from '../src/server/tools/get_import_by_id'
import { registerResolveTypeTool } from '../src/server/tools/resolve_type'
import { registerFindSimilarPatternsTool } from '../src/server/tools/find_similar_patterns'
import { registerFindDeadCodeTool } from '../src/server/tools/find_dead_code'
import { registerGetUntestedSymbolsTool } from '../src/server/tools/get_untested_symbols'
import { registerGetSymbolImportanceTool } from '../src/server/tools/get_symbol_importance'
import { registerGetDependencyCyclesTool } from '../src/server/tools/get_dependency_cycles'
import { registerGetCouplingMetricsTool } from '../src/server/tools/get_coupling_metrics'
import { registerAuditAgentConfigTool } from '../src/server/tools/audit_agent_config'
import { registerExploreCodebaseTool } from '../src/server/tools/explore_codebase'
import { registerGetTokenSavingsTool } from '../src/server/tools/get_token_savings'

/** A mock server implementation for MCP (Message Communication Protocol), providing functionality to register tools with specified schemas and handler functions. */
class MockMcpServer {
  tools = new Map<string, { schema: any; handler: Function }>()

  /** Registers a new tool with a specified name, schema, and handler function. */
  registerTool(name: string, schema: any, handler: Function) {
    /** Validates and processes input arguments using a specified schema before passing them to the handler function. */
    const wrappedHandler = async (args: any) => {
      const parsedArgs =
        schema.inputSchema && typeof schema.inputSchema.parse === 'function'
          ? schema.inputSchema.parse(args)
          : args
      return handler(parsedArgs)
    }
    this.tools.set(name, { schema, handler: wrappedHandler })
  }
}

describe('MCP Tool debugging setup', () => {
  let mockServer: MockMcpServer

  beforeAll(async () => {
    mockServer = new MockMcpServer()
    registerSearchSymbolsTool(mockServer as any)
    registerSemanticSearchSymbolsTool(mockServer as any)
    registerGetTypeAtLocationTool(mockServer as any)
    registerReadFileSnippetTool(mockServer as any)
    registerGetSymbolHistoryTool(mockServer as any)
    registerTraceErrorFlowTool(mockServer as any)
    registerGetRequiredEnvVarsTool(mockServer as any)
    registerGetFileDetailsTool(mockServer as any)
    registerGetDefinitionTool(mockServer as any)
    registerListFilesTool(mockServer as any)
    registerTraceCallGraphTool(mockServer as any)
    registerGetBlastRadiusTool(mockServer as any)
    registerFindSymbolReferencesTool(mockServer as any)
    registerTraceDataFlowTool(mockServer as any)
    registerGetCodebaseMapTool(mockServer as any)
    registerGetEntryPointsTool(mockServer as any)
    registerFindRelatedTestsTool(mockServer as any)
    registerGetImportsForFileTool(mockServer as any)
    registerGetImportByIdTool(mockServer as any)
    registerResolveTypeTool(mockServer as any)
    registerFindSimilarPatternsTool(mockServer as any)
    registerFindDeadCodeTool(mockServer as any)
    registerGetUntestedSymbolsTool(mockServer as any)
    registerGetSymbolImportanceTool(mockServer as any)
    registerGetDependencyCyclesTool(mockServer as any)
    registerGetCouplingMetricsTool(mockServer as any)
    registerAuditAgentConfigTool(mockServer as any)
    registerExploreCodebaseTool(mockServer as any)
    registerGetTokenSavingsTool(mockServer as any)
  })

  test('debug tool', async () => {
    const tool = mockServer.tools.get('get_blast_radius')
    expect(tool).toBeDefined()

    await tool?.handler({ symbol_name: 'IndexerDB' })
  })
})
