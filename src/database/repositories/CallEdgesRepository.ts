import type { Database, Statement } from 'bun:sqlite'
import * as schema from '../schemas'
import { getColumns } from 'drizzle-orm'

/** Manages a collection of call edges for dependency tracking within an application. Enables analysis of how different components or functions interact with each other. */
export class CallEdgesRepository {
  private callEdgesInsert: Statement | null = null

  /** Initializes a new instance of CallEdgesRepository with the provided SQLite database. */
  constructor(private sqlite: Database) {}

  /** Initializes the SQLite prepared statement for inserting call edge data. */
  initStatements() {
    const cols = Object.keys(getColumns(schema.call_edges))
    this.callEdgesInsert = this.sqlite.prepare(
      `INSERT INTO call_edges (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
  }

  /** Inserts multiple call edge records into the database based on the provided data. */
  async upsert(
    callEdgesData: schema.IndexedCallEdge['Insert'][],
  ): Promise<void> {
    if (!callEdgesData.length || !this.callEdgesInsert) return

    const cols = Object.keys(getColumns(schema.call_edges))
    this.sqlite.transaction(() => {
      for (const callEdge of callEdgesData) {
        this.callEdgesInsert!.run(
          ...cols.map((col) => (callEdge as any)[col] ?? null),
        )
      }
    })()
  }
}
