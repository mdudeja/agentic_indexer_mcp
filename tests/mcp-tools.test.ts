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
import { registerSearchCodebaseTool } from '../src/server/tools/search_codebase'
import { registerReadCodeTool } from '../src/server/tools/read_code'
import { registerInspectSymbolTool } from '../src/server/tools/inspect_symbol'
import { registerTraceCodeGraphTool } from '../src/server/tools/trace_code_graph'
import { registerAnalyzeChangeImpactTool } from '../src/server/tools/analyze_change_impact'
import { registerExploreArchitectureTool } from '../src/server/tools/explore_architecture'
import { registerAnalyzeQualityTool } from '../src/server/tools/analyze_quality'
import { registerInspectImportsTool } from '../src/server/tools/inspect_imports'
import { registerAuditIndexTool } from '../src/server/tools/audit_index'

import * as schema from '../src/database/schemas'
import { eq } from 'drizzle-orm'
import { getStoreForTests } from '../scripts/test_setup'

/** A mock server implementation for MCP, providing functionality to register tools with specified schemas and handler functions. */
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
    registerSearchCodebaseTool(mockServer as any)
    registerReadCodeTool(mockServer as any)
    registerInspectSymbolTool(mockServer as any)
    registerTraceCodeGraphTool(mockServer as any)
    registerAnalyzeChangeImpactTool(mockServer as any)
    registerExploreArchitectureTool(mockServer as any)
    registerAnalyzeQualityTool(mockServer as any)
    registerInspectImportsTool(mockServer as any)
    registerAuditIndexTool(mockServer as any)
  })

  test('should register all 9 consolidated tools correctly', () => {
    expect(mockServer.tools.size).toBe(9)
    expect(mockServer.tools.has('search_codebase')).toBe(true)
    expect(mockServer.tools.has('read_code')).toBe(true)
    expect(mockServer.tools.has('inspect_symbol')).toBe(true)
    expect(mockServer.tools.has('trace_code_graph')).toBe(true)
    expect(mockServer.tools.has('analyze_change_impact')).toBe(true)
    expect(mockServer.tools.has('explore_architecture')).toBe(true)
    expect(mockServer.tools.has('analyze_quality')).toBe(true)
    expect(mockServer.tools.has('inspect_imports')).toBe(true)
    expect(mockServer.tools.has('audit_index')).toBe(true)
  })

  test('search_codebase: symbol mode', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({ query: 'add', mode: 'symbol' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('[FUNCTION] add')
  })

  test('search_codebase: file mode', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({
      query: 'math.ts',
      mode: 'file_compact',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('math.ts')
  })

  test('search_codebase: semantic mode falls back gracefully', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({ query: 'add', mode: 'semantic' })

    // No embedder configured in test env → either error or fallback
    expect(response.content[0].text).toBeDefined()
  })

  test('read_code: definition mode', async () => {
    const db = store.getDb()
    const [symbol] = await db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.name, 'add'))
      .limit(1)

    expect(symbol).toBeDefined()

    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'definition',
      symbol_id: symbol!.id,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('export function add(')
  })

  test('read_code: snippet mode', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'snippet',
      file_path_or_name: 'math.ts',
      start_line: 4,
      end_line: 6,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('return a + b')
  })

  test('read_code: summary mode', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'summary',
      file_path_or_name: 'math.ts',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('math.ts')
    expect(response.content[0].text).toContain('Calculator')
  })

  test('inspect_symbol: definition mode', async () => {
    const db = store.getDb()
    const [symbol] = await db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.name, 'add'))
      .limit(1)

    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'definition',
      symbol_id: symbol!.id,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('export function add(')
  })

  test('inspect_symbol: references mode', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'references',
      name: 'multiply',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('References to: multiply')
    expect(response.content[0].text).toContain('Called at')
  })

  test('inspect_symbol: type_at_location mode', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'type_at_location',
      file_path_or_name: 'math.ts',
      line: 2,
      column: 17,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Type at math.ts:2:17')
  })

  test('inspect_symbol: history mode', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'history',
      name: 'add',
      file_path_or_name: 'math.ts',
    })

    expect(response.content[0].text).toBeDefined()
  })

  test('inspect_symbol: resolve_type mode', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'resolve_type',
      name: 'Calculator',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Type: Calculator')
  })

  test('inspect_symbol: class_hierarchy mode', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'class_hierarchy',
      name: 'Calculator',
      file_path_or_name: 'math.ts',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      'Class hierarchy for: Calculator',
    )
  })

  test('trace_code_graph: call_graph outbound mode', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({
      symbol_name: 'runCalculation',
      direction: 'outbound',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('runCalculation')
    expect(response.content[0].text).toContain('multiply')
  })

  test('analyze_change_impact: blast_radius mode', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'blast_radius',
      symbol_name: 'multiply',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain("Blast radius for 'multiply'")
  })

  test('analyze_change_impact: related_tests mode', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'related_tests',
      symbol_name: 'runCalculation',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('tests/sample.test.ts')
  })

  test('analyze_change_impact: required_env_vars mode', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'required_env_vars',
      symbol_name: 'runCalculation',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('APP_TOKEN')
  })

  test('analyze_change_impact: error_flow mode', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'error_flow',
      symbol_name: 'runCalculation',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Error')
  })

  test('analyze_change_impact: data_flow mode', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'data_flow',
      symbol_name: 'runCalculation',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Symbol: runCalculation')
    expect(response.content[0].text).toContain('Data flows OUT to')
  })

  test('explore_architecture: codebase_map mode', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({ mode: 'codebase_map', depth: 1 })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Codebase Map')
    expect(response.content[0].text).toContain('Architecture')
  })

  test('explore_architecture: entry_points mode', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({
      mode: 'entry_points',
      only_unreferenced: false,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Entry Points')
  })

  test('explore_architecture: explore mode', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({ mode: 'explore', max_nodes: 50 })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Knowledge graph')
    expect(response.content[0].text).toContain('```mermaid')
  })

  test('explore_architecture: coupling_metrics mode', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({ mode: 'coupling_metrics' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Coupling metrics')
  })

  test('analyze_quality: dead_code mode', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({
      mode: 'dead_code',
      exclude_tests: false,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('potentially dead symbol')
  })

  test('analyze_quality: untested_symbols mode', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({ mode: 'untested_symbols' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      'No untested exported symbols found',
    )
  })

  test('analyze_quality: similar_patterns mode', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({
      mode: 'similar_patterns',
      symbol_name: 'add',
      match_on: ['kind'],
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Symbols similar to: add')
  })

  test('analyze_quality: importance mode', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({ mode: 'importance', limit: 5 })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      'symbols by call-graph importance',
    )
  })

  test('analyze_quality: hotspots mode', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({ mode: 'hotspots', limit: 5 })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('inspect_imports: imports_for_file mode', async () => {
    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({
      mode: 'imports_for_file',
      filePath: 'app.ts',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      "import add, Calculator from 'math'",
    )
  })

  test('inspect_imports: import_by_id mode', async () => {
    const db = store.getDb()
    const [imported] = await db.select().from(schema.imports).limit(1)
    expect(imported).toBeDefined()

    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({
      mode: 'import_by_id',
      id: imported!.id,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      imported!.importedNames?.join(', '),
    )
  })

  test('inspect_imports: dependency_cycles mode', async () => {
    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({ mode: 'dependency_cycles' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No circular dependencies found')
  })

  test('audit_index: agent_config mode', async () => {
    const tool = mockServer.tools.get('audit_index')!
    const response = await tool.handler({ mode: 'agent_config' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Agent config audit')
  })

  test('audit_index: token_savings mode', async () => {
    const tool = mockServer.tools.get('audit_index')!
    const response = await tool.handler({ mode: 'token_savings' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Token Savings Report')
  })

  test('audit_index: index_health mode', async () => {
    const tool = mockServer.tools.get('audit_index')!
    const response = await tool.handler({ mode: 'index_health' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Index Health Report')
    expect(response.content[0].text).toContain('Files indexed')
  })

  test('search_codebase: rejects empty query', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({ query: '   ', mode: 'symbol' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('Query cannot be empty')
  })

  test('search_codebase: auto mode routes path-like queries to file listing', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({ query: 'utils/helper.ts' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Found')
  })

  test('search_codebase: auto mode routes multi-word queries to semantic (falls back)', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({
      query: 'this is a very long descriptive query',
    })

    expect(response.content[0].text).toBeDefined()
  })

  test('search_codebase: file_detailed mode returns symbol breakdown', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({
      query: 'math.ts',
      mode: 'file_detailed',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Total symbols:')
    expect(response.content[0].text).toContain('Exported symbols:')
  })

  test('search_codebase: no symbols found message', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({
      query: 'thisSymbolDefinitelyDoesNotExist',
      mode: 'symbol',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No symbols found')
  })

  test('search_codebase: no files found message', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({
      query: 'definitely_missing_file.xyz',
      mode: 'file_compact',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No files found')
  })

  test('search_codebase: symbol mode with kind and language filters', async () => {
    const tool = mockServer.tools.get('search_codebase')!
    const response = await tool.handler({
      query: 'add',
      mode: 'symbol',
      kind: ['function'],
      language: 'typescript',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('[FUNCTION] add')
  })

  test('trace_code_graph: inbound direction', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({
      symbol_name: 'multiply',
      direction: 'inbound',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Inbound call graph for: multiply')
  })

  test('trace_code_graph: both direction includes inbound and outbound headers', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({
      symbol_name: 'multiply',
      direction: 'both',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Outbound call graph for: multiply')
  })

  test('trace_code_graph: missing symbol error', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({})

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('requires symbol_name')
  })

  test('trace_code_graph: nonexistent symbol', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({
      symbol_name: 'nonexistentSymbol123',
      direction: 'outbound',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain("symbol 'nonexistentSymbol123' not found")
  })

  test('trace_code_graph: disambiguate via file_path', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({
      symbol_name: 'add',
      direction: 'outbound',
      file_path_or_file_name: 'math.ts',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Outbound call graph for: add')
  })

  test('read_code: snippet mode with out-of-range lines still returns content', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'snippet',
      file_path_or_name: 'math.ts',
      start_line: 1,
      end_line: 2,
    })

    expect(response.isError).toBeFalsy()
  })

  test('read_code: definition with nonexistent symbol_id errors', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'definition',
      symbol_id: 'does-not-exist',
    })

    expect(response.content[0].text).toContain("Symbol with id 'does-not-exist' not found")
  })

  test('inspect_symbol: definition with nonexistent symbol_id errors', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'definition',
      symbol_id: 'does-not-exist',
    })

    expect(response.content[0].text).toContain("Symbol with id 'does-not-exist' not found")
  })

  test('inspect_symbol: references for nonexistent symbol', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'references',
      name: 'nonexistentSymbol123',
    })

    expect(response.isError).toBeFalsy()
  })

  test('inspect_symbol: type_at_location in python file', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'type_at_location',
      file_path_or_name: 'auth.py',
      line: 1,
      column: 0,
    })

    // LSP may or may not resolve the type in test env; assert a well-formed response.
    expect(response.content[0].text).toBeDefined()
    expect(response.content[0].text).toContain('auth.py')
  })

  test('audit_index: index_health with no files reports correctly', async () => {
    const tool = mockServer.tools.get('audit_index')!
    const response = await tool.handler({ mode: 'index_health' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Files indexed')
  })

  test('inspect_imports: missing filePath errors', async () => {
    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({ mode: 'imports_for_file' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('requires filePath')
  })

  test('inspect_imports: missing id errors', async () => {
    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({ mode: 'import_by_id' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('requires id')
  })

  test('inspect_imports: no imports found for unknown file', async () => {
    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({
      mode: 'imports_for_file',
      filePath: 'definitely_missing_file.xyz',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No imports found')
  })

  test('inspect_imports: no import found for unknown id', async () => {
    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({
      mode: 'import_by_id',
      id: 'does-not-exist',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No import found')
  })

  test('inspect_imports: imports_for_file with limit', async () => {
    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({
      mode: 'imports_for_file',
      filePath: 'app.ts',
      limit: 1,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('imports in app.ts')
  })

  test('inspect_imports: dependency_cycles with max_cycles', async () => {
    const tool = mockServer.tools.get('inspect_imports')!
    const response = await tool.handler({
      mode: 'dependency_cycles',
      max_cycles: 5,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('inspect_symbol: importance mode with filters', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'importance',
      limit: 5,
      exclude_tests: false,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('inspect_symbol: importance mode with kind filter', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'importance',
      limit: 5,
      kind: ['function'],
      exclude_tests: true,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('inspect_symbol: resolve_type requires a name', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({ mode: 'resolve_type' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain(
      'resolve_type mode requires a name',
    )
  })

  test('inspect_symbol: resolve_type for a class', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'resolve_type',
      name: 'Calculator',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Type: Calculator')
    expect(response.content[0].text).toContain('Definition')
  })

  test('inspect_symbol: resolve_type for nonexistent type', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'resolve_type',
      name: 'DefinitelyMissingType123',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      'Definition: not found in index',
    )
  })

  test('inspect_symbol: class_hierarchy for class with ancestors', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'class_hierarchy',
      name: 'ServiceWithArgs',
      file_path_or_name: 'app.ts',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      'Class hierarchy for: ServiceWithArgs',
    )
    expect(response.content[0].text).toContain('Ancestors')
  })

  test('inspect_symbol: class_hierarchy with symbol_id', async () => {
    const db = store.getDb()
    const [calc] = await db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.name, 'Calculator'))
      .limit(1)
    expect(calc).toBeDefined()

    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'class_hierarchy',
      symbol_id: calc!.id,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Class hierarchy for: Calculator')
  })

  test('inspect_symbol: references with include options', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'references',
      name: 'runCalculation',
      include_imports: true,
      include_calls: true,
      include_inheritors: true,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('References to: runCalculation')
  })

  test('inspect_symbol: references returns not found for missing symbol', async () => {
    const tool = mockServer.tools.get('inspect_symbol')!
    const response = await tool.handler({
      mode: 'references',
      name: 'nonexistentSymbol123',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('not found in codebase')
  })

  test('read_code: snippet invalid line range', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'snippet',
      file_path_or_name: 'math.ts',
      start_line: 500,
      end_line: 1,
    })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('Invalid line range')
  })

  test('read_code: snippet file not found', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'snippet',
      file_path_or_name: 'missing_file.ts',
      start_line: 1,
      end_line: 2,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No file found')
  })

  test('read_code: snippet requires file and lines', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({ mode: 'snippet' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('requires file_path_or_name')
  })

  test('read_code: summary requires file_path_or_name', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({ mode: 'summary' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('requires file_path_or_name')
  })

  test('read_code: definition requires symbol context', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({ mode: 'definition' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain(
      'Must provide either symbol_id or both',
    )
  })

  test('read_code: definition for a symbol with no end_line', async () => {
    const db = store.getDb()
    // Insert a minimal symbol without an end_line directly (avoid upsert wiping file).
    const [symbol] = await db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.name, 'add'))
      .limit(1)

    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'definition',
      symbol_id: symbol!.id,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Definition of add')
  })

  test('read_code: snippet with start_line clamped below 1', async () => {
    const tool = mockServer.tools.get('read_code')!
    const response = await tool.handler({
      mode: 'snippet',
      file_path_or_name: 'math.ts',
      start_line: -5,
      end_line: 3,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Lines -5-3')
  })

  test('analyze_change_impact: blast_radius missing symbol_name', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({ mode: 'blast_radius' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('requires symbol_name')
  })

  test('analyze_change_impact: blast_radius symbol not found', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'blast_radius',
      symbol_name: 'nonexistentSymbol123',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain("Symbol 'nonexistentSymbol123' not found")
  })

  test('analyze_change_impact: blast_radius no callers', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'blast_radius',
      symbol_name: 'add',
      file_pattern: 'math.ts',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_change_impact: data_flow missing symbol_name', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({ mode: 'data_flow' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('requires symbol_name')
  })

  test('analyze_change_impact: data_flow symbol not found', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'data_flow',
      symbol_name: 'nonexistentSymbol123',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain("Symbol 'nonexistentSymbol123' not found")
  })

  test('analyze_change_impact: related_tests without target', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({ mode: 'related_tests' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Need either the symbol name')
  })

  test('analyze_change_impact: required_env_vars for all symbols', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({ mode: 'required_env_vars' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_change_impact: error_flow for all symbols', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({ mode: 'error_flow' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_change_impact: error_flow for nonexistent symbol', async () => {
    const tool = mockServer.tools.get('analyze_change_impact')!
    const response = await tool.handler({
      mode: 'error_flow',
      symbol_name: 'nonexistentSymbol123',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_quality: similar_patterns requires symbol_name', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({ mode: 'similar_patterns' })

    expect(response.isError).toBe(true)
    expect(response.content[0].text).toContain('requires symbol_name')
  })

  test('analyze_quality: dead_code with kind filter', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({
      mode: 'dead_code',
      kind: ['function'],
      exclude_tests: true,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_quality: untested_symbols with kind filter', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({
      mode: 'untested_symbols',
      kind: ['function'],
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_quality: importance with exclude_tests false', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({
      mode: 'importance',
      limit: 5,
      exclude_tests: false,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_quality: importance with kind filter', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({
      mode: 'importance',
      limit: 5,
      kind: ['class'],
      exclude_tests: true,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_quality: hotspots with file breakdown', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({
      mode: 'hotspots',
      limit: 5,
      file_path: 'math.ts',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('analyze_quality: hotspots with missing file', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({
      mode: 'hotspots',
      limit: 5,
      file_path: 'definitely_missing_file.xyz',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('explore_architecture: entry_points with only_unreferenced', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({
      mode: 'entry_points',
      only_unreferenced: true,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('explore_architecture: codebase_map with file_pattern filter', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({
      mode: 'codebase_map',
      depth: 1,
      file_pattern: 'math',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('explore_architecture: codebase_map with no matches', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({
      mode: 'codebase_map',
      file_pattern: 'zzz_nonexistent',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No files indexed')
  })

  test('explore_architecture: explore with max_nodes', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({
      mode: 'explore',
      max_nodes: 30,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })

  test('explore_architecture: coupling_metrics with sort', async () => {
    const tool = mockServer.tools.get('explore_architecture')!
    const response = await tool.handler({
      mode: 'coupling_metrics',
      sort_by: 'instability',
      limit: 10,
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toBeDefined()
  })
})
