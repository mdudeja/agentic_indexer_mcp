import { describe, expect, beforeAll, test, mock } from 'bun:test'
mock.module('simple-git', () => {
  return {
    simpleGit: (cwd?: string) => {
      return {
        raw: async (args: string[]) => {
          if (args.includes('fail') || (cwd && cwd.includes('fail'))) {
            throw new Error('git command failed')
          }
          if (args.includes('empty') || (cwd && cwd.includes('empty'))) {
            return ''
          }
          // Check if lines argument has the filepath 'empty' or 'fail'
          if (args.some((a) => a.includes(':empty'))) {
            return ''
          }
          if (args.some((a) => a.includes(':fail'))) {
            throw new Error('git command failed')
          }
          return 'commit a1b2c3d4e5f6\nAuthor: Jane Doe\nDate: Mon Jun 30\n\n    Add calculation test\n'
        },
      }
    },
  }
})
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
import { randomUUID } from 'crypto'
import { AppStateManager } from '../src/state'

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

describe('MCP Tools Integration Tests', () => {
  let store: IndexerDB
  let mockServer: MockMcpServer

  beforeAll(async () => {
    store = getStoreForTests()

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
    expect(response.content[0].text).toContain('runCalculation')
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

  test('find_related_tests edge cases and branches', async () => {
    const tool = mockServer.tools.get('find_related_tests')!

    // Seed a mock test file and a source file in DB
    await store.files.upsert({
      path: 'tests/my_module.test.ts',
      hash: 'h-test',
      language: 'typescript',
      estimated_tokens: 50,
    })
    await store.files.upsert({
      path: 'src/my_module.ts',
      hash: 'h-src',
      language: 'typescript',
      estimated_tokens: 50,
    })

    // Seed import from the test file to our module
    const importId = randomUUID()
    await store.imports.upsert([
      {
        id: importId,
        file_path: 'tests/my_module.test.ts',
        module_path: 'src/my_module.ts',
        imported_name: 'myFunc',
      },
    ])

    // Seed call from test file to the symbol
    const callerSymId = randomUUID()
    const calleeSymId = randomUUID()
    await store.symbols.upsert([
      {
        id: callerSymId,
        name: 'testMyFunc',
        kind: schema.SymbolKind.function,
        file_path: 'tests/my_module.test.ts',
        line: 5,
        column: 1,
        language: 'typescript',
        exported: true,
      },
      {
        id: calleeSymId,
        name: 'myFunc',
        kind: schema.SymbolKind.function,
        file_path: 'src/my_module.ts',
        line: 2,
        column: 1,
        language: 'typescript',
        exported: true,
      },
    ])

    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: callerSymId,
        callee_name: 'myFunc',
        callee_id: calleeSymId,
        language_name: 'typescript',
        caller_file_path: 'tests/my_module.test.ts',
        call_text: 'myFunc()',
        is_lang_feature: false,
        call_line: 6,
        call_column: 4,
      },
    ])

    // A. Target looks like file path
    const resFile = await tool.handler({ target: 'src/my_module.ts' })
    expect(resFile.isError).toBeFalsy()
    expect(resFile.content[0].text).toContain("imports module 'myFunc'")

    // B. Target is symbol name
    const resSym = await tool.handler({ target: 'myFunc' })
    expect(resSym.isError).toBeFalsy()
    expect(resSym.content[0].text).toContain('calls myFunc via testMyFunc')
    expect(resSym.content[0].text).toContain("imports 'myFunc' by name")

    // C. Target not referenced by any tests
    const resNone = await tool.handler({ target: 'unreferencedFunc' })
    expect(resNone.isError).toBeFalsy()
    expect(resNone.content[0].text).toContain('No test files found referencing')

    // D. Error handling (catch block)
    const originalGetImporters = store.imports.getImporters
    store.imports.getImporters = () => {
      throw new Error('DB simulated error')
    }
    const resErr = await tool.handler({ target: 'src/error.ts' })
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error finding related tests')
    store.imports.getImporters = originalGetImporters
  })

  test('get_definition edge cases and branches', async () => {
    const tool = mockServer.tools.get('get_definition')!

    // A. Omit symbol_id and name/path (error)
    const resParams = await tool.handler({})
    expect(resParams.isError).toBe(true)
    expect(resParams.content[0].text).toContain(
      'Must provide either symbol_id or both name and file_path',
    )

    // B. Multiple files match path error
    await store.files.upsert({
      path: 'src/duplicate_file_1.ts',
      hash: 'h-dup1',
      language: 'typescript',
      estimated_tokens: 10,
    })
    await store.files.upsert({
      path: 'src/duplicate_file_2.ts',
      hash: 'h-dup2',
      language: 'typescript',
      estimated_tokens: 10,
    })
    const resDup = await tool.handler({
      name: 'func',
      file_path_or_name: 'duplicate_file',
    })
    expect(resDup.isError).toBeFalsy()
    expect(resDup.content[0].text).toContain('Multiple files found matching')

    // C. File not found matching path
    const resNotFound = await tool.handler({
      name: 'func',
      file_path_or_name: 'non_existent_file',
    })
    expect(resNotFound.isError).toBeFalsy()
    expect(resNotFound.content[0].text).toContain('No file found matching')

    // D. Symbol not found
    const resNoSym = await tool.handler({
      name: 'non_existent_symbol',
      file_path_or_name: 'math.ts',
    })
    expect(resNoSym.isError).toBeFalsy()
    expect(resNoSym.content[0].text).toContain('Symbol not found')

    // E. Missing end_line fallback (slice 10 lines limit)
    const symNoEndLineId = randomUUID()
    await store.symbols.upsert([
      {
        id: symNoEndLineId,
        name: 'noEndLineSym',
        kind: schema.SymbolKind.function,
        file_path: 'math.ts',
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])
    const resNoEnd = await tool.handler({ symbol_id: symNoEndLineId })
    expect(resNoEnd.isError).toBeFalsy()
    expect(resNoEnd.content[0].text).toContain('// ... (truncated)')

    // F. Catch block error
    const originalGetDefinition = store.symbols.getDefinition
    store.symbols.getDefinition = () => {
      throw new Error('Simulated getDefinition error')
    }
    const resErr = await tool.handler({ symbol_id: 'some-id' })
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error getting definition')
    store.symbols.getDefinition = originalGetDefinition
  })

  test('get_untested_symbols edge cases and branches', async () => {
    const tool = mockServer.tools.get('get_untested_symbols')!

    // A. Empty test files in index error
    const originalConfig = AppStateManager.getInstance().getItem('config')
    AppStateManager.getInstance().setItem('config', {
      ...originalConfig!,
      testFilePatterns: [],
    })
    const resNoTests = await tool.handler({})
    expect(resNoTests.isError).toBeFalsy()
    expect(resNoTests.content[0].text).toContain(
      'No test files found in the indexed workspace',
    )

    AppStateManager.getInstance().setItem('config', originalConfig)

    // B. All files covered by tests
    AppStateManager.getInstance().setItem('config', {
      ...originalConfig!,
      testFilePatterns: [/.*/],
    })
    const resAllCovered = await tool.handler({})
    expect(resAllCovered.isError).toBeFalsy()
    expect(resAllCovered.content[0].text).toContain(
      'All non-test files are imported by test files',
    )

    AppStateManager.getInstance().setItem('config', originalConfig)

    // C. No untested exported symbols found
    const resNoUntested = await tool.handler({ limit: 0 })
    expect(resNoUntested.isError).toBeFalsy()
    expect(resNoUntested.content[0].text).toContain(
      'No untested exported symbols found',
    )

    // D. Error path
    const originalGetAll = store.files.getAll
    store.files.getAll = () => {
      throw new Error('Simulated files error')
    }
    const resErr = await tool.handler({})
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error finding untested symbols')
    store.files.getAll = originalGetAll
  })

  test('trace_call_graph edge cases and branches', async () => {
    const tool = mockServer.tools.get('trace_call_graph')!

    // A. Multiple files matching path error
    const resDup = await tool.handler({
      symbol_name: 'func',
      direction: 'both',
      file_path_or_file_name: 'duplicate_file',
    })
    expect(resDup.isError).toBeFalsy()
    expect(resDup.content[0].text).toContain('Multiple files found matching')

    // B. File not found
    const resNotFound = await tool.handler({
      symbol_name: 'func',
      direction: 'both',
      file_path_or_file_name: 'non_existent_file',
    })
    expect(resNotFound.isError).toBeFalsy()
    expect(resNotFound.content[0].text).toContain('No file found matching')

    // C. Symbol not found warning
    const resNoSym = await tool.handler({
      symbol_name: 'non_existent_symbol',
      direction: 'both',
    })
    expect(resNoSym.isError).toBeFalsy()
    expect(resNoSym.content[0].text).toContain('not found in index')

    // D. Outbound and inbound BFS cycle detection & broken link & unresolved import & unresolved/inbuilt command
    const fileA = 'src/fileA.ts'
    await store.files.upsert({
      path: fileA,
      hash: 'h-fileA',
      language: 'typescript',
      estimated_tokens: 10,
    })

    const symAId = randomUUID()
    const brokenCalleeId = randomUUID()
    const symBId = randomUUID()
    const classId = randomUUID()
    const methodId = randomUUID()
    const duplicateSymbolIdA = randomUUID()

    // Seed all symbols on fileA at once to avoid subsequent upserts from deleting previous records on fileA.
    await store.symbols.upsert([
      {
        id: symAId,
        name: 'functionA',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: brokenCalleeId,
        name: 'brokenFunc',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 10,
        column: 0,
        language: 'typescript',
        exported: false,
      },
      {
        id: symBId,
        name: 'functionB',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 20,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: classId,
        name: 'MyClass',
        kind: schema.SymbolKind.class,
        file_path: fileA,
        line: 30,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: methodId,
        name: 'myMethod',
        kind: schema.SymbolKind.method,
        parent_id: classId,
        file_path: fileA,
        line: 31,
        column: 4,
        language: 'typescript',
        exported: false,
      },
      {
        id: duplicateSymbolIdA,
        name: 'duplicateSymbol',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 40,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])

    const impId = randomUUID()
    await store.imports.upsert([
      {
        id: impId,
        file_path: fileA,
        module_path: 'external-module',
        imported_name: 'externalFunc',
      },
    ])

    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: symAId,
        callee_name: 'functionA',
        callee_id: symAId,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'functionA()',
        is_lang_feature: false,
        call_line: 1,
        call_column: 0,
      },
      {
        id: randomUUID(),
        caller_id: symAId,
        callee_name: 'brokenFunc',
        callee_id: brokenCalleeId,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'brokenFunc()',
        is_lang_feature: false,
        call_line: 2,
        call_column: 0,
      },
      {
        id: randomUUID(),
        caller_id: symAId,
        callee_name: 'externalFunc',
        imports_id: impId,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'externalFunc()',
        is_lang_feature: false,
        call_line: 3,
        call_column: 0,
      },
      {
        id: randomUUID(),
        caller_id: symAId,
        callee_name: 'console.log',
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'console.log()',
        is_lang_feature: false,
        call_line: 4,
        call_column: 0,
      },
    ])

    // Stub getDefinition to return null specifically for brokenCalleeId to simulate a broken link
    const originalGetDef = store.symbols.getDefinition
    store.symbols.getDefinition = (async (id: string) => {
      if (id === brokenCalleeId) return null
      return originalGetDef.call(store.symbols, id)
    }) as any

    const resOut = await tool.handler({
      symbol_name: 'functionA',
      direction: 'outbound',
    })

    // Restore original method immediately
    store.symbols.getDefinition = originalGetDef

    expect(resOut.isError).toBeFalsy()
    expect(resOut.content[0].text).toContain('[cycle]')
    expect(resOut.content[0].text).toContain('(broken link)')
    expect(resOut.content[0].text).toContain(
      '(externalFunc from external-module)',
    )
    expect(resOut.content[0].text).toContain(
      'console.log (unresolved or inbuilt command at line 5)',
    )

    // F. Inbound calls, cycles, and nested child class callers
    // Seed calls: B -> A, A -> B (cycle)
    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: symBId,
        callee_name: 'functionA',
        callee_id: symAId,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'functionA()',
        is_lang_feature: false,
        call_line: 21,
        call_column: 0,
      },
      {
        id: randomUUID(),
        caller_id: symAId,
        callee_name: 'functionB',
        callee_id: symBId,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'functionB()',
        is_lang_feature: false,
        call_line: 5,
        call_column: 0,
      },
    ])

    const resIn = await tool.handler({
      symbol_name: 'functionA',
      direction: 'inbound',
    })
    expect(resIn.isError).toBeFalsy()
    expect(resIn.content[0].text).toContain('[cycle]')

    // Seed call from B -> myMethod
    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: symBId,
        callee_name: 'myMethod',
        callee_id: methodId,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'obj.myMethod()',
        is_lang_feature: false,
        call_line: 22,
        call_column: 0,
      },
    ])

    const resClassIn = await tool.handler({
      symbol_name: 'MyClass',
      direction: 'inbound',
    })
    expect(resClassIn.isError).toBeFalsy()
    expect(resClassIn.content[0].text).toContain('myMethod')
    expect(resClassIn.content[0].text).toContain('functionB')

    // G. Multiple matching symbols warning paths
    const fileB = 'src/fileB.ts'
    await store.files.upsert({
      path: fileB,
      hash: 'h-fileB',
      language: 'typescript',
      estimated_tokens: 10,
    })
    await store.symbols.upsert([
      {
        id: randomUUID(),
        name: 'duplicateSymbol',
        kind: schema.SymbolKind.function,
        file_path: fileB,
        line: 40,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])

    const resDupSym = await tool.handler({
      symbol_name: 'duplicateSymbol',
      direction: 'both',
    })
    expect(resDupSym.content[0].text).toContain(
      "symbols named 'duplicateSymbol' found",
    )

    // H. Unresolved import branch
    const impId2 = randomUUID()
    await store.imports.upsert([
      {
        id: impId2,
        file_path: fileA,
        module_path: 'ghost-module',
        imported_name: 'unresolvedImportFunc',
      },
    ])
    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: symAId,
        callee_name: 'unresolvedImportFunc',
        imports_id: impId2,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'unresolvedImportFunc()',
        is_lang_feature: false,
        call_line: 12,
        call_column: 0,
      },
    ])

    const originalGetImport = store.imports.getById
    store.imports.getById = (async (id: string) => {
      if (id === impId2) return null
      return originalGetImport.call(store.imports, id)
    }) as any

    const resUnresolvedImp = await tool.handler({
      symbol_name: 'functionA',
      direction: 'outbound',
    })
    store.imports.getById = originalGetImport
    expect(resUnresolvedImp.content[0].text).toContain('unresolved import')

    // E. Error path
    const originalSearch = store.symbols.search
    store.symbols.search = () => {
      throw new Error('Simulated search error')
    }
    const resErr = await tool.handler({
      symbol_name: 'functionA',
      direction: 'inbound',
    })
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error tracing call graph')
    store.symbols.search = originalSearch
  })

  test('get_coupling_metrics edge cases and branches', async () => {
    const tool = mockServer.tools.get('get_coupling_metrics')!

    // A. Sorting by instability, afferent, and efferent keys
    const resI = await tool.handler({ sort_by: 'instability' })
    expect(resI.isError).toBeFalsy()
    const resCa = await tool.handler({ sort_by: 'afferent' })
    expect(resCa.isError).toBeFalsy()
    const resCe = await tool.handler({ sort_by: 'efferent' })
    expect(resCe.isError).toBeFalsy()

    // B. No files found in the index
    const originalGetAll = store.files.getAll
    store.files.getAll = async () => []
    const resEmpty = await tool.handler({})
    expect(resEmpty.isError).toBeFalsy()
    expect(resEmpty.content[0].text).toContain(
      'No files with symbols found in the index',
    )
    store.files.getAll = originalGetAll

    // C. Error path
    store.files.getAll = () => {
      throw new Error('Simulated metrics error')
    }
    const resErr = await tool.handler({})
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error computing coupling metrics')
    store.files.getAll = originalGetAll
  })

  test('get_required_env_vars edge cases and branches', async () => {
    const tool = mockServer.tools.get('get_required_env_vars')!

    // A. No env vars found downstream
    const resNone = await tool.handler({ symbol_name: 'add' })
    expect(resNone.isError).toBeFalsy()
    expect(resNone.content[0].text).toContain(
      'No environment variable reads found',
    )

    // B. Direct vs indirect env vars accesses
    const fileA = 'src/fileA.ts'
    await store.files.upsert({
      path: fileA,
      hash: 'h-fileA',
      language: 'typescript',
      estimated_tokens: 10,
    })

    const callerId = randomUUID()
    const calleeId = randomUUID()

    await store.symbols.upsert([
      {
        id: callerId,
        name: 'callerFunc',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: calleeId,
        name: 'calleeFunc',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 10,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])

    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: callerId,
        callee_name: 'calleeFunc',
        callee_id: calleeId,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'calleeFunc()',
        is_lang_feature: false,
        call_line: 1,
        call_column: 0,
      },
    ])

    const db = store.getDb()
    await db.insert(schema.env_vars).values([
      {
        id: randomUUID(),
        symbol_id: callerId,
        file_path: fileA,
        name: 'DIRECT_VAR',
        line: 2,
        column: 4,
      },
      {
        id: randomUUID(),
        symbol_id: calleeId,
        file_path: fileA,
        name: 'INDIRECT_VAR',
        line: 12,
        column: 4,
      },
    ])

    const res = await tool.handler({ symbol_name: 'callerFunc' })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain(
      'Directly Accessed (inside "callerFunc")',
    )
    expect(res.content[0].text).toContain('DIRECT_VAR')
    expect(res.content[0].text).toContain('Downstream Accessed')
    expect(res.content[0].text).toContain('INDIRECT_VAR')

    // C. Error path
    const originalGetEnv = store.analysis.getEnvVarsBubbleUp
    store.analysis.getEnvVarsBubbleUp = () => {
      throw new Error('Simulated env error')
    }
    const resErr = await tool.handler({ symbol_name: 'callerFunc' })
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain(
      'Error tracing environment variables',
    )
    store.analysis.getEnvVarsBubbleUp = originalGetEnv
  })

  test('trace_error_flow edge cases and branches', async () => {
    const tool = mockServer.tools.get('trace_error_flow')!

    // A. No exceptions found
    const resNone = await tool.handler({ symbol_name: 'add' })
    expect(resNone.isError).toBeFalsy()
    expect(resNone.content[0].text).toContain(
      'No exceptions found throwing or bubbling up',
    )

    // B. Direct vs indirect exceptions throwing
    const fileA = 'src/fileA.ts'
    await store.files.upsert({
      path: fileA,
      hash: 'h-fileA',
      language: 'typescript',
      estimated_tokens: 10,
    })

    const callerId = randomUUID()
    const calleeId = randomUUID()

    await store.symbols.upsert([
      {
        id: callerId,
        name: 'callerErrFunc',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: calleeId,
        name: 'calleeErrFunc',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 10,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])

    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: callerId,
        callee_name: 'calleeErrFunc',
        callee_id: calleeId,
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'calleeErrFunc()',
        is_lang_feature: false,
        call_line: 1,
        call_column: 0,
      },
    ])

    const db = store.getDb()
    await db.insert(schema.exceptions).values([
      {
        id: randomUUID(),
        symbol_id: callerId,
        file_path: fileA,
        exception_type: 'DirectError',
        line: 2,
        column: 4,
      },
      {
        id: randomUUID(),
        symbol_id: calleeId,
        file_path: fileA,
        exception_type: 'IndirectError',
        line: 12,
        column: 4,
      },
    ])

    const res = await tool.handler({ symbol_name: 'callerErrFunc' })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain(
      'Direct Exceptions (thrown inside "callerErrFunc")',
    )
    expect(res.content[0].text).toContain('DirectError')
    expect(res.content[0].text).toContain('Bubbled Up Exceptions')
    expect(res.content[0].text).toContain('IndirectError')

    // C. Error path
    const originalGetExceptions = store.analysis.getExceptionsBubbleUp
    store.analysis.getExceptionsBubbleUp = () => {
      throw new Error('Simulated exception error')
    }
    const resErr = await tool.handler({ symbol_name: 'callerErrFunc' })
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error tracing exception flow')
    store.analysis.getExceptionsBubbleUp = originalGetExceptions
  })

  test('read_file_snippet edge cases and branches', async () => {
    const tool = mockServer.tools.get('read_file_snippet')!

    // A. File not found
    const resNotFound = await tool.handler({
      file_path: 'non_existent_file.ts',
      start_line: 1,
      end_line: 10,
    })
    expect(resNotFound.isError).toBe(true)
    expect(resNotFound.content[0].text).toContain('File not found')

    // B. Invalid line range (start > end)
    const resInvalidRange = await tool.handler({
      file_path: 'math.ts',
      start_line: 2000,
      end_line: 10,
    })
    expect(resInvalidRange.isError).toBe(true)
    expect(resInvalidRange.content[0].text).toContain('Invalid line range')

    // C. Catch block error
    const resErr = await tool.handler({
      file_path: '.',
      start_line: 1,
      end_line: 10,
    })
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error reading file snippet')
  })

  test('get_symbol_history edge cases and branches', async () => {
    const tool = mockServer.tools.get('get_symbol_history')!

    // Seed empty and fail files for git simulation paths
    await store.files.upsert({
      path: 'empty',
      hash: 'h-empty',
      language: 'typescript',
      estimated_tokens: 1,
    })
    await store.files.upsert({
      path: 'fail',
      hash: 'h-fail',
      language: 'typescript',
      estimated_tokens: 1,
    })

    // A. Using symbol_id directly
    const symId = randomUUID()
    await store.symbols.upsert([
      {
        id: symId,
        name: 'historySym',
        kind: schema.SymbolKind.function,
        file_path: 'math.ts',
        line: 0,
        column: 0,
        end_line: 5,
        language: 'typescript',
        exported: true,
      },
    ])
    const resId = await tool.handler({ symbol_id: symId })
    expect(resId.isError).toBeFalsy()
    expect(resId.content[0].text).toContain('commit a1b2c3d4e5f6')

    // B. Missing parameters validation
    const resParams = await tool.handler({})
    expect(resParams.isError).toBe(true)
    expect(resParams.content[0].text).toContain(
      'Must provide either symbol_id, or both name and file_path_or_name',
    )

    // C. File not found matching path
    const resFileNotFound = await tool.handler({
      name: 'historySym',
      file_path_or_name: 'non_existent_file',
    })
    expect(resFileNotFound.isError).toBe(true)
    expect(resFileNotFound.content[0].text).toContain('File not found matching')

    // D. Multiple files matching path error
    const resDup = await tool.handler({
      name: 'historySym',
      file_path_or_name: 'duplicate_file',
    })
    expect(resDup.isError).toBe(true)
    expect(resDup.content[0].text).toContain('Multiple files found matching')

    // E. Symbol not found
    const resNoSym = await tool.handler({
      name: 'non_existent_symbol',
      file_path_or_name: 'math.ts',
    })
    expect(resNoSym.isError).toBe(true)
    expect(resNoSym.content[0].text).toContain('Symbol not found in index')

    // F. Missing end_line validation
    const symNoEndId = randomUUID()
    await store.symbols.upsert([
      {
        id: symNoEndId,
        name: 'noEndLineHistory',
        kind: schema.SymbolKind.function,
        file_path: 'math.ts',
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])
    const resNoEnd = await tool.handler({ symbol_id: symNoEndId })
    expect(resNoEnd.isError).toBe(true)
    expect(resNoEnd.content[0].text).toContain(
      'does not have line bounds in the database',
    )

    // G. Empty log response from git
    const symEmptyId = randomUUID()
    await store.symbols.upsert([
      {
        id: symEmptyId,
        name: 'emptyGitSym',
        kind: schema.SymbolKind.function,
        file_path: 'empty',
        line: 0,
        column: 0,
        end_line: 2,
        language: 'typescript',
        exported: true,
      },
    ])
    const resEmpty = await tool.handler({ symbol_id: symEmptyId })
    expect(resEmpty.isError).toBeFalsy()
    expect(resEmpty.content[0].text).toContain(
      'No commit history found for these lines',
    )

    // H. Catch block error from git throw
    const symFailId = randomUUID()
    await store.symbols.upsert([
      {
        id: symFailId,
        name: 'failGitSym',
        kind: schema.SymbolKind.function,
        file_path: 'fail',
        line: 0,
        column: 0,
        end_line: 2,
        language: 'typescript',
        exported: true,
      },
    ])
    const resFail = await tool.handler({ symbol_id: symFailId })
    expect(resFail.isError).toBe(true)
    expect(resFail.content[0].text).toContain('Error fetching symbol history')
  })

  test('find_dead_code edge cases and branches', async () => {
    const tool = mockServer.tools.get('find_dead_code')!

    // Setup custom testFilePatterns to cover regex, string, and invalid config mapping branches
    const originalConfig = AppStateManager.getInstance().getItem('config')
    AppStateManager.getInstance().setItem('config', {
      ...originalConfig!,
      testFilePatterns: [
        /\.test\.ts$/, // regex
        '\\.spec\\.ts$', // string pattern
        12345 as any, // invalid configuration
      ],
    })

    // A. Class inheritance hierarchies
    const fileH = 'src/hierarchy.ts'
    await store.files.upsert({
      path: fileH,
      hash: 'h-hierarchy',
      language: 'typescript',
      estimated_tokens: 20,
    })

    const parentId = randomUUID()
    const childId = randomUUID()
    const parentMethodId = randomUUID()
    const childMethodId = randomUUID()

    const childCtorId = randomUUID()
    await store.symbols.upsert([
      {
        id: parentId,
        name: 'ParentClass',
        kind: schema.SymbolKind.class,
        file_path: fileH,
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: parentMethodId,
        name: 'myOverriddenMethod',
        kind: schema.SymbolKind.method,
        parent_id: parentId,
        file_path: fileH,
        line: 1,
        column: 4,
        language: 'typescript',
        exported: false,
      },
      {
        id: childId,
        name: 'ChildClass',
        kind: schema.SymbolKind.class,
        file_path: fileH,
        line: 5,
        column: 0,
        language: 'typescript',
        exported: true,
        inheritence: JSON.stringify([
          {
            inherits_from_name: 'ParentClass',
            inheritence_type: schema.InheritenceType.extends,
          },
        ]) as any,
      },
      {
        id: childMethodId,
        name: 'myOverriddenMethod',
        kind: schema.SymbolKind.method,
        parent_id: childId,
        file_path: fileH,
        line: 6,
        column: 4,
        language: 'typescript',
        exported: false,
      },
      {
        id: childCtorId,
        name: 'constructor',
        kind: schema.SymbolKind.method,
        parent_id: childId,
        file_path: fileH,
        line: 7,
        column: 4,
        language: 'typescript',
        exported: false,
      },
    ])

    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: parentId,
        callee_name: 'myOverriddenMethod',
        callee_id: parentMethodId,
        language_name: 'typescript',
        caller_file_path: fileH,
        call_text: 'super.myOverriddenMethod()',
        is_lang_feature: false,
        call_line: 2,
        call_column: 0,
      },
    ])

    const res = await tool.handler({ exclude_tests: false })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).not.toContain('method constructor')

    // C. No dead code found path
    const resNone = await tool.handler({ limit: 0 })
    expect(resNone.content[0].text).toContain('No dead code detected')

    // D. Error path
    const originalGetDb = store.getDb
    store.getDb = () => {
      throw new Error('Simulated getDb error')
    }
    const resErr = await tool.handler({})
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error finding dead code')
    store.getDb = originalGetDb

    AppStateManager.getInstance().setItem('config', originalConfig)
  })

  test('find_symbol_references edge cases and branches', async () => {
    const tool = mockServer.tools.get('find_symbol_references')!

    // Seed two duplicate symbols in fileA and fileB to trigger multiple symbols match error
    const fileA = 'src/fileA.ts'
    const fileB = 'src/fileB.ts'
    await store.files.upsert({
      path: fileA,
      hash: 'h-fileA',
      language: 'typescript',
      estimated_tokens: 10,
    })
    await store.files.upsert({
      path: fileB,
      hash: 'h-fileB',
      language: 'typescript',
      estimated_tokens: 10,
    })
    await store.symbols.upsert([
      {
        id: randomUUID(),
        name: 'duplicateSymbol',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 40,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])
    await store.symbols.upsert([
      {
        id: randomUUID(),
        name: 'duplicateSymbol',
        kind: schema.SymbolKind.function,
        file_path: fileB,
        line: 40,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])

    // A. Symbol not found
    const resNone = await tool.handler({ symbol_name: 'non_existent_symbol' })
    expect(resNone.content[0].text).toContain(
      "Symbol 'non_existent_symbol' not found",
    )

    // B. Multiple symbols found error
    const resDup = await tool.handler({ symbol_name: 'duplicateSymbol' })
    expect(resDup.content[0].text).toContain('Multiple symbols found with name')

    // C. No sections populated path
    const symId = randomUUID()
    const moduleSymId = randomUUID()
    const filePath = 'tests/my_module.test.ts'
    await store.symbols.upsert([
      {
        id: symId,
        name: 'uniqueNoRefs',
        kind: schema.SymbolKind.function,
        file_path: filePath,
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
      {
        id: moduleSymId,
        name: 'my/module/path.ts',
        kind: schema.SymbolKind.function,
        file_path: filePath,
        line: 50,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])
    const resNoSections = await tool.handler({
      symbol_name: 'uniqueNoRefs',
      include_calls: false,
      include_imports: false,
      include_inheritors: false,
    })
    expect(resNoSections.content[0].text).toContain(
      'No references found for: uniqueNoRefs',
    )

    // D. None found fallback text in sections
    const resFallbacks = await tool.handler({
      symbol_name: 'uniqueNoRefs',
      include_calls: true,
      include_imports: true,
      include_inheritors: true,
    })
    expect(resFallbacks.content[0].text).toContain('Called at: (none found)')
    expect(resFallbacks.content[0].text).toContain(
      'Imported by name: (none found)',
    )
    expect(resFallbacks.content[0].text).toContain('Inherited by: (none found)')

    // E. Module-level importers path
    const resModule = await tool.handler({
      symbol_name: 'my/module/path.ts',
      include_calls: false,
      include_imports: false,
      include_inheritors: false,
    })
    expect(resModule.content[0].text).toContain(
      'Module imported by: (none found)',
    )

    // F. Catch block error
    const originalSearch = store.symbols.search
    store.symbols.search = () => {
      throw new Error('Simulated search error')
    }
    const resErr = await tool.handler({ symbol_name: 'uniqueNoRefs' })
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error finding references')
    store.symbols.search = originalSearch
  })

  test('get_blast_radius edge cases and branches', async () => {
    const tool = mockServer.tools.get('get_blast_radius')!

    // Seed two duplicate symbols in fileA and fileB to trigger multiple symbols match error
    const fileA = 'src/fileA.ts'
    const fileB = 'src/fileB.ts'
    await store.files.upsert({
      path: fileA,
      hash: 'h-fileA',
      language: 'typescript',
      estimated_tokens: 10,
    })
    await store.files.upsert({
      path: fileB,
      hash: 'h-fileB',
      language: 'typescript',
      estimated_tokens: 10,
    })
    await store.symbols.upsert([
      {
        id: randomUUID(),
        name: 'duplicateSymbol',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 40,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])
    await store.symbols.upsert([
      {
        id: randomUUID(),
        name: 'duplicateSymbol',
        kind: schema.SymbolKind.function,
        file_path: fileB,
        line: 40,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])

    // A. Symbol not found
    const resNone = await tool.handler({ symbol_name: 'non_existent_symbol' })
    expect(resNone.content[0].text).toContain(
      "Symbol 'non_existent_symbol' not found",
    )

    // B. Multiple symbols found error
    const resDup = await tool.handler({ symbol_name: 'duplicateSymbol' })
    expect(resDup.content[0].text).toContain('Multiple symbols found with name')

    // C. No callers found
    const symId = randomUUID()
    const filePath = 'tests/my_module.test.ts'
    await store.symbols.upsert([
      {
        id: symId,
        name: 'uniqueNoCallers',
        kind: schema.SymbolKind.function,
        file_path: filePath,
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])
    const resNoCallers = await tool.handler({ symbol_name: 'uniqueNoCallers' })
    expect(resNoCallers.content[0].text).toContain(
      "No callers found for 'uniqueNoCallers'",
    )

    // D. Catch block error
    const originalSearch = store.symbols.search
    store.symbols.search = () => {
      throw new Error('Simulated search error')
    }
    const resErr = await tool.handler({ symbol_name: 'uniqueNoCallers' })
    expect(resErr.isError).toBe(true)
    expect(resErr.content[0].text).toContain('Error finding blast radius')
    store.symbols.search = originalSearch
  })

  test('explore_codebase edge cases and branches', async () => {
    const tool = mockServer.tools.get('explore_codebase')!

    // A. No symbols match filters
    const resNone = await tool.handler({ file_pattern: 'non_existent_pattern' })
    expect(resNone.content[0].text).toContain(
      'No symbols matched the given filters',
    )

    // B. Include unresolved ghost nodes and edges
    // Seed an unresolved call in db
    const fileA = 'src/fileA.ts'
    const symId = randomUUID()
    await store.symbols.upsert([
      {
        id: symId,
        name: 'myFuncWithGhost',
        kind: schema.SymbolKind.function,
        file_path: fileA,
        line: 0,
        column: 0,
        language: 'typescript',
        exported: true,
      },
    ])
    await store.calls.upsert([
      {
        id: randomUUID(),
        caller_id: symId,
        callee_name: 'ghostCallee',
        language_name: 'typescript',
        caller_file_path: fileA,
        call_text: 'ghostCallee()',
        is_lang_feature: false,
        call_line: 1,
        call_column: 0,
      },
    ])

    const resGhost = await tool.handler({
      include_unresolved: true,
      file_pattern: 'fileA.ts',
    })
    expect(resGhost.content[0].text).toContain('subgraph ghost')
    expect(resGhost.content[0].text).toContain('-.->')

    // C. Catch block error path
    const originalGetAll = store.files.getAll
    store.files.getAll = () => {
      throw new Error('Simulated files error')
    }
    const resErr = await tool.handler({})
    expect(resErr.content[0].text).toContain('explore_codebase failed')
    store.files.getAll = originalGetAll
  })
})
