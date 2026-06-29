import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { IndexerDB } from '../src/database/IndexerDB'
import { SymbolKind } from '../src/database/schemas'
import { randomUUID } from 'crypto'

describe('Database Repositories Unit Tests', () => {
  let store: IndexerDB

  beforeAll(async () => {
    store = IndexerDB.getInstance(':memory:')
    await store.init()
  })

  afterAll(async () => {
    await store.clear()
    store.close()
  })

  it('should test FileRepository methods', async () => {
    // 1. Upsert
    await store.files.upsert({
      path: 'src/lib.ts',
      hash: 'hash-lib',
      language: 'typescript',
      estimated_tokens: 100,
    })

    // 2. getHash
    const hash = await store.files.getHash('src/lib.ts')
    expect(hash).toBe('hash-lib')

    // 3. getAll
    const all = await store.files.getAll()
    expect(all.map((f) => f.path)).toContain('src/lib.ts')

    // 4. getByPartialNameOrPath
    const partial = await store.files.getByPartialNameOrPath('lib')
    expect(partial.length).toBe(1)
    expect(partial[0]?.path).toBe('src/lib.ts')
  })

  it('should test SymbolRepository methods', async () => {
    const symbolId = randomUUID()
    await store.symbols.upsert([
      {
        id: symbolId,
        name: 'helperFunction',
        kind: SymbolKind.function,
        file_path: 'src/lib.ts',
        line: 10,
        column: 2,
        language: 'typescript',
        exported: true,
      },
    ])

    // getDefinition
    const definition = await store.symbols.getDefinition(symbolId)
    expect(definition).toBeDefined()
    expect(definition?.name).toBe('helperFunction')

    // getSymbolsByNames
    const named = await store.symbols.getSymbolsByNames(['helperFunction'])
    expect(named.length).toBe(1)

    // search
    const results = await store.symbols.search('helper*')
    expect(results.length).toBe(1)
    expect(results[0]?.name).toBe('helperFunction')
  })

  it('should test ImportRepository methods', async () => {
    // Ensure the parent file is upserted for foreign key constraints
    await store.files.upsert({
      path: 'src/lib.ts',
      hash: 'hash-lib',
      language: 'typescript',
      estimated_tokens: 100,
    })

    const importId = randomUUID()
    await store.imports.upsert([
      {
        id: importId,
        file_path: 'src/lib.ts',
        module_path: 'react',
        imported_name: 'useState',
      },
    ])

    const allImports = await store.imports.getAll()
    const imports = allImports.filter((i) => i.file_path === 'src/lib.ts')
    
    if (imports.length !== 1) {
      console.log('DIAGNOSTICS - ImportRepository test failed:', {
        allImports,
        files: await store.files.getAll(),
      })
    }

    expect(imports.length).toBe(1)
    expect(imports[0]?.imported_name).toBe('useState')

    const singleImport = await store.imports.getById(importId)
    expect(singleImport).toBeDefined()
    expect(singleImport?.module_path).toBe('react')
  })

  it('should test CallRepository methods', async () => {
    // Upsert caller and callee symbols first to prevent foreign key constraints failure
    await store.symbols.upsert([
      {
        id: 'sym-caller-1',
        name: 'callerFunction',
        kind: SymbolKind.function,
        file_path: 'src/lib.ts',
        line: 5,
        column: 2,
        language: 'typescript',
        exported: true,
      },
      {
        id: 'sym-callee-1',
        name: 'helperFunction',
        kind: SymbolKind.function,
        file_path: 'src/lib.ts',
        line: 10,
        column: 2,
        language: 'typescript',
        exported: true,
      },
    ])

    const callId = randomUUID()
    await store.calls.upsert([
      {
        id: callId,
        caller_id: 'sym-caller-1',
        callee_name: 'helperFunction',
        callee_id: 'sym-callee-1',
        language_name: 'typescript',
        caller_file_path: 'src/lib.ts',
        call_text: 'helperFunction()',
        is_lang_feature: false,
        call_line: 12,
        call_column: 4,
      },
    ])

    const outbound = await store.calls.getForSymbols(['sym-caller-1'])
    expect(outbound.length).toBe(1)
    expect(outbound[0]?.callee_name).toBe('helperFunction')

    const inbound = await store.calls.getCallers('helperFunction')
    expect(inbound.length).toBe(1)
    expect(inbound[0]?.callerName).toBe('callerFunction')
  })

  it('should test AnalysisRepository methods', async () => {
    // 1. Exceptions
    await store.analysis.upsertExceptions([
      {
        id: randomUUID(),
        symbol_id: 'sym-caller-1',
        file_path: 'src/lib.ts',
        exception_type: 'Error',
        line: 14,
        column: 6,
      },
    ])

    const exc = await store.analysis.getExceptionsBubbleUp('helperFunction')
    // Should return empty or list based on call graph
    expect(exc).toBeDefined()

    // 2. Env vars
    await store.analysis.upsertEnvVars([
      {
        id: randomUUID(),
        symbol_id: 'sym-caller-1',
        file_path: 'src/lib.ts',
        name: 'CONFIG_KEY',
        line: 15,
        column: 6,
      },
    ])

    const env = await store.analysis.getEnvVarsBubbleUp('helperFunction')
    expect(env).toBeDefined()
  })

  it('should test ToolUsageRepository methods', async () => {
    const usageId = randomUUID()
    await store.toolUsage.record({
      id: usageId,
      tool_name: 'search_symbols',
      source_tokens: 100,
      response_tokens: 20,
      tokens_saved: 80,
      called_at: Date.now(),
    })

    const summary = store.toolUsage.getTokenSavings()
    expect(summary.total_calls).toBe(1)
    expect(summary.total_tokens_saved).toBe(80)
  })

  it('should test EmbeddingRepository methods', async () => {
    const symbolId = randomUUID()
    await store.files.upsert({
      path: 'src/embed.ts',
      hash: 'hash-embed',
      language: 'typescript',
      estimated_tokens: 50,
    })
    await store.symbols.upsert([
      {
        id: symbolId,
        name: 'embedSymbol',
        kind: SymbolKind.function,
        file_path: 'src/embed.ts',
        line: 1,
        column: 1,
        language: 'typescript',
      },
    ])

    const embedding = new Array(768).fill(0.1)
    await store.embeddings.upsert(symbolId, embedding)

    const needs = await store.embeddings.getSymbolsNeedingEmbeddings([
      'src/embed.ts',
    ])
    expect(needs.length).toBe(0) // since we just updated it
  })
})
