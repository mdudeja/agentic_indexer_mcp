import { IndexerDB } from 'src/database/IndexerDB'
import * as schema from '../database/schemas'

/** Returns all languages present in the codebase. */
export async function allCodebaseLanguages(): Promise<Set<string>> {
  const store = IndexerDB.getInstance()
  const db = store.getDb()

  let languages: Set<string> = new Set<string>()

  const all_files = await db
    .select({ language: schema.files.language })
    .from(schema.files)

  all_files.forEach((f) => {
    if (f.language) {
      languages = languages ?? new Set<string>()
      languages.add(f.language)
    }
  })

  return languages
}
