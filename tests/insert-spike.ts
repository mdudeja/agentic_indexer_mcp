import { logInfo } from 'src/utils/logger'
import { IndexerDB } from '../src/database/IndexerDB'
import * as schema from '../src/database/schemas'

/** Initialize an in-memory database, insert test files and symbols data, and log the inserted records. */
async function main() {
  const store = IndexerDB.getInstance(':memory:')
  await store.init()
  const db = store.getDb()

  await db
    .insert(schema.files)
    .values({ path: 'test.ts', hash: 'abc', indexed_at: 123, language: 'ts' })

  await db.insert(schema.symbols).values({
    id: 'sym1',
    name: 'myFunction',
    kind: schema.SymbolKind.function,
    file_path: 'test.ts',
    line: 10,
    column: 5,
    language: 'ts',
  })

  const res = await db.select().from(schema.symbols)
  logInfo('Inserted:', res)
}
main().catch(console.error)
