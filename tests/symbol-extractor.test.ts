import { describe, it, expect, beforeAll } from 'bun:test'
import { TreeSitterIndexer } from '../src/indexer/TreeSitterIndexer'
import { extractSymbols } from '../src/indexer/steps/s1_symbol_extractor'
import {
  seedModuleSymbol,
  extractCallDocstring,
} from '../src/indexer/adapters/LanguageAdapter'
import { SymbolKind } from '../src/database/schemas'

/** Creates a minimal mock tree-sitter node with just the fields the tested helpers use. */
function makeNode(overrides: Record<string, any> = {}): any {
  return {
    id: 1,
    type: 'program',
    text: '',
    childCount: 0,
    previousSibling: null,
    nextSibling: null,
    parent: null,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 1, column: 0 },
    ...overrides,
  }
}

describe('s1_symbol_extractor', () => {
  let indexer: TreeSitterIndexer

  beforeAll(async () => {
    indexer = new TreeSitterIndexer()
    await indexer.init()
  })

  it('returns an empty default result when rootNode or query is missing', async () => {
    const result = extractSymbols(null as any, 'file.ts', 'typescript')
    expect(result.symbols).toEqual([])
    expect(result.imports).toEqual([])
    expect(result.exceptions).toEqual([])
    expect(result.envVars).toEqual([])
    expect(result.explicitExports).toEqual([])
  })

  it('extracts symbols for a valid language and query', async () => {
    const result = await indexer.parse(
      'export function foo(a: number): number { return a }',
      'ts',
      'file.ts',
    )
    expect(result.symbols.length).toBeGreaterThan(0)
    expect(result.symbols.some((s) => s.name === 'foo')).toBe(true)
  })

  it('extracts symbols for python', async () => {
    const result = await indexer.parse(
      'def bar(x):\n    return x + 1',
      'py',
      'file.py',
    )
    expect(result.symbols.some((s) => s.name === 'bar')).toBe(true)
  })
})

describe('seedModuleSymbol', () => {
  it('does nothing for an empty root node (no children)', () => {
    const root = makeNode({ childCount: 0 })
    const nodeToSymbolId = new Map<number, string>()
    const result: any = { symbols: [] }
    seedModuleSymbol(root, 'file.ts', 'typescript', nodeToSymbolId, result)
    expect(nodeToSymbolId.size).toBe(0)
    expect(result.symbols.length).toBe(0)
  })

  it('seeds a module symbol for a non-empty root', () => {
    const root = makeNode({
      childCount: 2,
      endPosition: { row: 10, column: 5 },
    })
    const nodeToSymbolId = new Map<number, string>()
    const result: any = { symbols: [] }
    seedModuleSymbol(root, 'file.ts', 'typescript', nodeToSymbolId, result)
    expect(nodeToSymbolId.has(root.id)).toBe(true)
    expect(result.symbols.length).toBe(1)
    const sym = result.symbols[0]!
    expect(sym.name).toBe('<module>')
    expect(sym.kind).toBe(SymbolKind.module)
    expect(sym.file_path).toBe('file.ts')
    expect(sym.line).toBe(0)
    expect(sym.end_line).toBe(10)
  })
})

describe('extractCallDocstring', () => {
  it('returns null when node is null', () => {
    expect(extractCallDocstring(null)).toBeNull()
  })

  it('returns null when no comment siblings exist', () => {
    const node = makeNode({
      parent: makeNode({ type: 'statement_block' }),
      previousSibling: null,
      nextSibling: null,
    })
    expect(extractCallDocstring(node)).toBeNull()
  })

  it('extracts a preceding comment docstring', () => {
    const comment = makeNode({
      type: 'comment',
      text: '// this is a docstring',
    })
    const node = makeNode({
      parent: makeNode({ type: 'program' }),
      previousSibling: comment,
      nextSibling: null,
    })
    const docstring = extractCallDocstring(node)
    expect(docstring).toBe('this is a docstring')
  })

  it('extracts a trailing inline comment on the same line', () => {
    const comment = makeNode({
      type: 'comment',
      text: '// trailing',
      startPosition: { row: 3, column: 11 },
    })
    const program = makeNode({ type: 'program' })
    const stmt = makeNode({
      type: 'expression_statement',
      endPosition: { row: 3, column: 10 },
      parent: program,
      nextSibling: comment,
    })
    const node = makeNode({
      type: 'call_expression',
      parent: stmt,
      previousSibling: null,
      nextSibling: null,
    })
    const docstring = extractCallDocstring(node)
    expect(docstring).toBe('trailing')
  })
})
