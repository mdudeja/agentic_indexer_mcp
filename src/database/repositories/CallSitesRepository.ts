import { Database, Statement } from 'bun:sqlite'
import * as schema from '../schemas'
import { getColumns } from 'drizzle-orm'

/** A repository for managing and tracking call site information within an application. */
export class CallSitesRepository {
  private callSitesInsert: Statement | null = null

  /** The constructor initializes a new instance of CallSitesRepository with a specified SQLite database to manage call sites data. */
  constructor(private sqlite: Database) {}

  /** Initializes the SQLite prepared statement for inserting call site data. */
  initStatements() {
    const cols = Object.keys(getColumns(schema.call_sites))
    this.callSitesInsert = this.sqlite.prepare(
      `INSERT INTO call_sites (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
  }

  /** Inserts multiple call site records into the database based on the provided data. */
  async upsert(
    callSitesData: schema.IndexedCallSite['Insert'][],
  ): Promise<void> {
    if (!callSitesData.length || !this.callSitesInsert) return

    const cols = Object.keys(getColumns(schema.call_sites))
    this.sqlite.transaction(() => {
      for (const callSite of callSitesData) {
        this.callSitesInsert!.run(
          ...cols.map((col) => (callSite as any)[col] ?? null),
        )
      }
    })()
  }
}
