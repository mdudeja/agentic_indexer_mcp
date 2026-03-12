import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { IndexerDB } from '../src/database/IndexerDB'
import { SymbolKind, type IndexedSymbol } from '../src/config/types'
import { randomUUID } from 'crypto'

describe('SymbolStore', () => {
  let store: IndexerDB

  beforeAll(async () => {
    store = IndexerDB.getInstance(':memory:')
    await store.init()
  })

  afterAll(async () => {
    await store.clear()
  })

  it('should upsert a file and retrieve its hash', async () => {
    await store.upsertFile({
      path: 'src/test.ts',
      hash: 'hash123',
      language: 'typescript',
    })
    const hash = await store.getFileHash('src/test.ts')
    expect(hash).toBe('hash123')
  })

  it('should update file hash on upsert', async () => {
    await store.upsertFile({
      path: 'src/test.ts',
      hash: 'hash456',
      language: 'typescript',
    })
    const hash = await store.getFileHash('src/test.ts')
    expect(hash).toBe('hash456')
  })

  it('should upsert symbols', async () => {
    const symbolId = randomUUID()
    const symbols: IndexedSymbol['Insert'][] = [
      {
        id: symbolId,
        name: 'testFunction',
        kind: SymbolKind.function,
        file_path: 'src/test.ts',
        line: 1,
        column: 0,
        end_line: 5,
        end_column: 1,
        signature: 'function testFunction()',
        exported: true,
      },
    ]

    await store.upsertSymbols(symbols)
    const result = await store.getDefinition(symbolId)

    expect(result).toBeDefined()
    expect(result?.name).toBe('testFunction')
    expect(result?.exported).toBe(true) // Checking sqlite boolean mapping
  })

  it('should search symbols by name pattern', async () => {
    const results = await store.searchSymbols('test*')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.name).toBe('testFunction')
  })

  it('should get a file summary', async () => {
    const summary = await store.getFileSummary('src/test.ts')
    expect(summary.length).toBe(1)
    expect(summary[0]!.name).toBe('testFunction')
  })

  it('should delete a file and cascade delete symbols', async () => {
    await store.deleteFile('src/test.ts')

    // File should be gone
    const hash = await store.getFileHash('src/test.ts')
    expect(hash).toBeNull()

    // Symbols should be gone
    const summary = await store.getFileSummary('src/test.ts')
    expect(summary.length).toBe(0)
  })
})
