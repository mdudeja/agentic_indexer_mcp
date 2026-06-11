import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { IndexerDB } from '../src/database/IndexerDB.ts'
import { SymbolKind } from '../src/config/types.ts'

describe('Contextual Tools DB and Graph Traversal', () => {
  let store: IndexerDB

  beforeAll(async () => {
    store = IndexerDB.getInstance(':memory:')
    await store.init()
  })

  afterAll(async () => {
    await store.clear()
  })

  it('should support sqlite-vec inserts and KNN searches', async () => {
    // Upsert file first to satisfy foreign key constraint
    await store.upsertFile({
      path: 'src/hello.ts',
      hash: 'hash-hello',
      language: 'typescript',
      estimated_tokens: 10,
    })

    const symbolId = 'test-sym-1'
    await store.upsertSymbols([{
      id: symbolId,
      name: 'helloWorld',
      kind: SymbolKind.function,
      file_path: 'src/hello.ts',
      line: 1,
      column: 0,
      language: 'typescript',
    }])

    const embedding = new Array(768).fill(0)
    embedding[0] = 0.5
    embedding[1] = 0.8

    // First upsert
    await store.upsertSymbolEmbedding(symbolId, embedding)

    // Second upsert to verify uniqueness and updates work without throwing
    const updatedEmbedding = new Array(768).fill(0)
    updatedEmbedding[0] = 0.9
    updatedEmbedding[1] = 0.1
    await store.upsertSymbolEmbedding(symbolId, updatedEmbedding)

    const results = await store.searchSymbolsHybrid('hello*', updatedEmbedding, SymbolKind.function, undefined, 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.symbol.name).toBe('helloWorld')
    expect(results[0]?.score).toBeGreaterThan(0)
  })

  it('should extract and traverse exception and env var flow downstream', async () => {
    // Upsert file first to satisfy foreign key constraint
    await store.upsertFile({
      path: 'src/main.ts',
      hash: 'hash-main',
      language: 'typescript',
      estimated_tokens: 50,
    })

    await store.upsertSymbols([
      { id: 'sym-A', name: 'funcA', kind: SymbolKind.function, file_path: 'src/main.ts', line: 1, column: 0, language: 'typescript' },
      { id: 'sym-B', name: 'funcB', kind: SymbolKind.function, file_path: 'src/main.ts', line: 10, column: 0, language: 'typescript' },
      { id: 'sym-C', name: 'funcC', kind: SymbolKind.function, file_path: 'src/main.ts', line: 20, column: 0, language: 'typescript' },
    ])

    await store.upsertCalls([
      { id: 'call-1', caller_id: 'sym-A', callee_name: 'funcB', callee_id: 'sym-B', language_name: 'typescript', caller_file_path: 'src/main.ts', call_text: 'funcB()', call_line: 2, call_column: 2 },
      { id: 'call-2', caller_id: 'sym-B', callee_name: 'funcC', callee_id: 'sym-C', language_name: 'typescript', caller_file_path: 'src/main.ts', call_text: 'funcC()', call_line: 11, call_column: 2 },
    ])

    await store.upsertExceptions([
      { id: 'exc-1', symbol_id: 'sym-B', file_path: 'src/main.ts', exception_type: 'TypeError', line: 12, column: 4 },
      { id: 'exc-2', symbol_id: 'sym-C', file_path: 'src/main.ts', exception_type: 'ValueError', line: 22, column: 4 },
    ])

    await store.upsertEnvVars([
      { id: 'env-1', symbol_id: 'sym-C', file_path: 'src/main.ts', name: 'DB_URL', line: 23, column: 4 },
    ])

    const exceptions = await store.getExceptionsBubbleUp('funcA')
    expect(exceptions.length).toBe(2)
    const types = exceptions.map((e) => e.exception_type)
    expect(types).toContain('TypeError')
    expect(types).toContain('ValueError')

    const envVars = await store.getEnvVarsBubbleUp('funcA')
    expect(envVars.length).toBe(1)
    expect(envVars[0]?.env_var_name).toBe('DB_URL')
  })
})
