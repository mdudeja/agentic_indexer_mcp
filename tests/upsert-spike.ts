import { logInfo } from 'src/utils/logger'
import { IndexerDB } from '../src/database/IndexerDB'
import { SymbolKind, type IndexedSymbol } from '../src/config/types'

/** Demonstrates usage of IndexerDB by initializing the database, adding sample file and symbol data, searching for symbols named "myVar", and logging the results. */
async function main() {
  const store = IndexerDB.getInstance(':memory:')
  await store.init()
  await store.upsertFile({
    path: 'test.ts',
    hash: 'abc',
    language: 'typescript',
  })
  const symbols: IndexedSymbol['Insert'][] = [
    {
      id: '1',
      name: 'myVar',
      kind: SymbolKind.var,
      file_path: 'test.ts',
      line: 1,
      column: 1,
      end_line: 1,
      end_column: 2,
      signature: 'const myVar = 1',
      exported: true,
      language: 'typescript',
    },
  ]
  await store.upsertSymbols(symbols)
  const results = await store.searchSymbols('myVar')
  logInfo('Results:', results)
}
main().catch(console.error)
