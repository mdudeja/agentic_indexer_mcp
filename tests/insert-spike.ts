import { logInfo } from 'src/utils/logger'
import { IndexerDB } from '../src/database/IndexerDB'
import * as schema from '../src/database/schemas'

async function main() {
  const store = IndexerDB.getInstance(':memory:')
  await store.init()
  const db = store.getDb()

  await db
    .insert(schema.files)
    .values({ path: 'test.ts', hash: 'abc', indexed_at: 123, language: 'ts' })

  await db.insert(schema.symbols).values({
    id: 'some-id',
    name: 'testFunc',
    kind: schema.SymbolKind.function,
    file_path: 'test.ts',
    line: 1,
    column: 1,
    exported: true, // Drizzle boolean mode
  })

  const res = await db.select().from(schema.symbols)
  logInfo('Inserted:', res)
}
main().catch(console.error)
