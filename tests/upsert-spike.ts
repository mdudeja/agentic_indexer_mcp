import { IndexerDB } from '../src/database/IndexerDB'
import type { IndexedSymbol } from '../src/indexer/types'

async function main() {
  const store = new IndexerDB(':memory:')
  await store.init()
  await store.upsertFile('test.ts', '123', 'ts')
  const symbols: IndexedSymbol[] = [
    {
      id: '1',
      name: 'myVar',
      kind: 'variable',
      filePath: 'test.ts',
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 2,
      signature: 'const myVar = 1',
      exported: true,
    },
  ]
  await store.upsertSymbols(symbols)
  const results = await store.searchSymbols('myVar')
  console.log('Results:', results)
}
main().catch(console.error)
