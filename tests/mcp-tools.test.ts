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
    const response = await tool.handler({ query: 'math.ts', mode: 'file_compact' })

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
      file_path: 'math.ts',
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
      type_name: 'Calculator',
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
    expect(response.content[0].text).toContain('Class hierarchy for: Calculator')
  })

  test('trace_code_graph: call_graph outbound mode', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({
      mode: 'call_graph',
      symbol_name: 'runCalculation',
      direction: 'outbound',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('runCalculation')
    expect(response.content[0].text).toContain('multiply')
  })

  test('trace_code_graph: blast_radius mode', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({
      mode: 'blast_radius',
      symbol_name: 'multiply',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain("Blast radius for 'multiply'")
    expect(response.content[0].text).toContain('runCalculation')
  })

  test('trace_code_graph: references mode', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({
      mode: 'references',
      symbol_name: 'multiply',
    })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('References to: multiply')
  })

  test('trace_code_graph: dependency_cycles mode', async () => {
    const tool = mockServer.tools.get('trace_code_graph')!
    const response = await tool.handler({ mode: 'dependency_cycles' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No circular dependencies found')
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
      target: 'runCalculation',
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
    const response = await tool.handler({ mode: 'dead_code', exclude_tests: false })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('potentially dead symbol')
  })

  test('analyze_quality: untested_symbols mode', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({ mode: 'untested_symbols' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('No untested exported symbols found')
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

  test('analyze_quality: coupling_metrics mode', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({ mode: 'coupling_metrics' })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('Coupling metrics')
  })

  test('analyze_quality: importance mode', async () => {
    const tool = mockServer.tools.get('analyze_quality')!
    const response = await tool.handler({ mode: 'importance', limit: 5 })

    expect(response.isError).toBeFalsy()
    expect(response.content[0].text).toContain('symbols by call-graph importance')
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
    expect(response.content[0].text).toContain("import add, Calculator from 'math'")
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
    expect(response.content[0].text).toContain(imported!.importedNames?.join(', '))
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
})
