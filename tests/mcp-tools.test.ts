import { describe, expect, beforeAll, test } from 'bun:test'
import { IndexerDB } from '../src/database/IndexerDB'
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

import * as schema from '../src/database/schemas'
import { eq } from 'drizzle-orm'
import { getStoreForTests } from '../scripts/test_setup'

/** A mock server implementation for MCP (Message Communication Protocol), providing functionality to register tools with specified schemas and handler functions. */
class MockMcpServer {
  tools = new Map<string, { schema: any; handler: Function }>()

  /** Registers a new tool with a specified name, schema, and handler function. */
  registerTool(name: string, schema: any, handler: Function) {
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

describe('MCP Tools Integration Tests', () => {
  let store: IndexerDB
  let mockServer: MockMcpServer

  beforeAll(async () => {
    store = getStoreForTests()

    // 3. Register tools on Mock MCP Server
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

  test('should register all tools correctly', () => {
    expect(mockServer.tools.size).toBe(29)
    expect(mockServer.tools.has('search_symbols')).toBe(true)
    expect(mockServer.tools.has('get_definition')).toBe(true)
    expect(mockServer.tools.has('get_imports_for_file')).toBe(true)
    expect(mockServer.tools.has('trace_call_graph')).toBe(true)
    expect(mockServer.tools.has('get_required_env_vars')).toBe(true)
  })

  test('should search symbols via search_symbols tool', async () => {
    const searchTool = mockServer.tools.get('search_symbols')!
    const response = await searchTool.handler({ query: 'add' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('[FUNCTION] add')
  })

  test('should fetch definition via get_definition tool', async () => {
    const db = store.getDb()
    const [symbol] = await db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.name, 'add'))
      .limit(1)

    expect(symbol).toBeDefined()

    const getDefinitionTool = mockServer.tools.get('get_definition')!
    const response = await getDefinitionTool.handler({ symbol_id: symbol!.id })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('export function add(')
  })

  test('should fetch imports via get_imports_for_file tool', async () => {
    const getImportsTool = mockServer.tools.get('get_imports_for_file')!
    const response = await getImportsTool.handler({ filePath: 'app.ts' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain("import add from 'math.ts'")
    expect(response.content[0].text).toContain(
      "import Calculator from 'math.ts'",
    )
  })

  test('should list files via list_files tool', async () => {
    const listFilesTool = mockServer.tools.get('list_files')!
    const response = await listFilesTool.handler({})

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('math.ts')
    expect(response.content[0].text).toContain('app.ts')
  })

  test('should trace call graph via trace_call_graph tool', async () => {
    const traceCallGraphTool = mockServer.tools.get('trace_call_graph')!
    const response = await traceCallGraphTool.handler({
      symbol_name: 'runCalculation',
      direction: 'outbound',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('runCalculation')
    expect(response.content[0].text).toContain('multiply')
  })

  test('should trace exceptions via trace_error_flow tool', async () => {
    const traceErrorFlowTool = mockServer.tools.get('trace_error_flow')!
    const response = await traceErrorFlowTool.handler({
      symbol_name: 'runCalculation',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Error')
  })

  test('should get required environment variables via get_required_env_vars tool', async () => {
    const getEnvVarsTool = mockServer.tools.get('get_required_env_vars')!
    const response = await getEnvVarsTool.handler({
      symbol_name: 'runCalculation',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('APP_TOKEN')
  })

  test('should audit agent configuration via audit_agent_config tool', async () => {
    const auditConfigTool = mockServer.tools.get('audit_agent_config')!
    const response = await auditConfigTool.handler({})

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Agent config audit')
  })

  test('should return token savings via get_token_savings tool', async () => {
    const getSavingsTool = mockServer.tools.get('get_token_savings')!
    const response = await getSavingsTool.handler({})

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Token Savings Report')
  })

  test('should fetch single import by ID via get_import_by_id tool', async () => {
    const db = store.getDb()
    const [imported] = await db.select().from(schema.imports).limit(1)
    expect(imported).toBeDefined()

    const getImportByIdTool = mockServer.tools.get('get_import_by_id')!
    const response = await getImportByIdTool.handler({ id: imported!.id })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(imported!.imported_name!)
  })

  test('should search symbols semantically via semantic_search_symbols tool', async () => {
    const semanticSearchTool = mockServer.tools.get('semantic_search_symbols')!
    const response = await semanticSearchTool.handler({ query: 'add' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('[FUNCTION] add')
  })

  test('should attempt to get type at location via get_type_at_location tool', async () => {
    const getTypeTool = mockServer.tools.get('get_type_at_location')!
    const response = await getTypeTool.handler({
      file_path: 'math.ts',
      line: 2,
      column: 17,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Could not resolve type')
  })

  test('should read file snippet via read_file_snippet tool', async () => {
    const readSnippetTool = mockServer.tools.get('read_file_snippet')!
    const response = await readSnippetTool.handler({
      file_path: 'math.ts',
      start_line: 4,
      end_line: 6,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('return a + b')
  })

  test('should handle get_symbol_history tool gracefully when git fails or is absent', async () => {
    const historyTool = mockServer.tools.get('get_symbol_history')!
    const response = await historyTool.handler({
      name: 'add',
      file_path_or_name: 'math.ts',
    })

    // It should either return git history or fail/error out gracefully
    expect(response.content[0].text).toBeDefined()
  })

  test('should fetch file details via get_file_details tool', async () => {
    const detailsTool = mockServer.tools.get('get_file_details')!
    const response = await detailsTool.handler({
      file_path_or_file_name: 'math.ts',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('File: math.ts')
    expect(response.content[0].text).toContain('Calculator')
  })

  test('should trace blast radius via get_blast_radius tool', async () => {
    const blastRadiusTool = mockServer.tools.get('get_blast_radius')!
    const response = await blastRadiusTool.handler({
      symbol_name: 'multiply',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain("Blast radius for 'multiply'")
    expect(response.content[0].text).toContain('prod')
  })

  test('should find symbol references via find_symbol_references tool', async () => {
    const refsTool = mockServer.tools.get('find_symbol_references')!
    const response = await refsTool.handler({
      symbol_name: 'multiply',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('References to: multiply')
    expect(response.content[0].text).toContain('Called at')
  })

  test('should trace data flow via trace_data_flow tool', async () => {
    const dataFlowTool = mockServer.tools.get('trace_data_flow')!
    const response = await dataFlowTool.handler({
      symbol_name: 'runCalculation',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Symbol: runCalculation')
    expect(response.content[0].text).toContain('Data flows OUT to')
  })

  test('should get codebase map via get_codebase_map tool', async () => {
    const mapTool = mockServer.tools.get('get_codebase_map')!
    const response = await mapTool.handler({
      depth: 1,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Codebase Map')
    expect(response.content[0].text).toContain('Architecture')
  })

  test('should fetch entry points via get_entry_points tool', async () => {
    const entryPointsTool = mockServer.tools.get('get_entry_points')!
    const response = await entryPointsTool.handler({
      only_unreferenced: false,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Entry Points')
  })

  test('should search related tests via find_related_tests tool', async () => {
    const relatedTestsTool = mockServer.tools.get('find_related_tests')!
    const response = await relatedTestsTool.handler({
      target: 'runCalculation',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No test files found')
  })

  test('should resolve types via resolve_type tool', async () => {
    const resolveTypeTool = mockServer.tools.get('resolve_type')!
    const response = await resolveTypeTool.handler({
      type_name: 'Calculator',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Type: Calculator')
  })

  test('should search similar patterns via find_similar_patterns tool', async () => {
    const patternsTool = mockServer.tools.get('find_similar_patterns')!
    const response = await patternsTool.handler({
      symbol_name: 'add',
      match_on: ['kind'],
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Symbols similar to: add')
  })

  test('should find dead code via find_dead_code tool', async () => {
    const deadCodeTool = mockServer.tools.get('find_dead_code')!
    const response = await deadCodeTool.handler({
      exclude_tests: false,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('potentially dead symbol')
  })

  test('should search untested symbols via get_untested_symbols tool', async () => {
    const untestedTool = mockServer.tools.get('get_untested_symbols')!
    const response = await untestedTool.handler({})

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No test files found')
  })

  test('should get symbol importance via get_symbol_importance tool', async () => {
    const importanceTool = mockServer.tools.get('get_symbol_importance')!
    const response = await importanceTool.handler({
      limit: 5,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      'symbols by call-graph importance',
    )
  })

  test('should trace dependency cycles via get_dependency_cycles tool', async () => {
    const cyclesTool = mockServer.tools.get('get_dependency_cycles')!
    const response = await cyclesTool.handler({})

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No circular dependencies found')
  })

  test('should fetch coupling metrics via get_coupling_metrics tool', async () => {
    const couplingTool = mockServer.tools.get('get_coupling_metrics')!
    const response = await couplingTool.handler({})

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Coupling metrics')
  })

  test('should explore codebase via explore_codebase tool', async () => {
    const exploreTool = mockServer.tools.get('explore_codebase')!
    const response = await exploreTool.handler({
      max_nodes: 50,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Knowledge graph')
    expect(response.content[0].text).toContain('```mermaid')
  })
})
