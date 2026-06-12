import { Database, Statement } from 'bun:sqlite'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import { eq, and, getColumns, inArray, isNull, isNotNull } from 'drizzle-orm'
import * as schema from '../schemas'
import type { IndexedSymbolCall } from '../schemas'
import type { DirectCaller, NestedCaller } from '../types'

export class CallRepository {
  private callInsert: Statement | null = null

  constructor(
    private sqlite: Database,
    private db: SQLiteBunDatabase<typeof schema>,
  ) {}

  initStatements() {
    const cols = Object.keys(getColumns(schema.symbol_calls))
    this.callInsert = this.sqlite.prepare(
      `INSERT INTO symbol_calls (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
  }

  async upsert(callsData: IndexedSymbolCall['Insert'][]): Promise<void> {
    if (!callsData.length || !this.callInsert) return

    const cols = Object.keys(getColumns(schema.symbol_calls))
    this.sqlite.transaction(() => {
      for (const call of callsData) {
        this.callInsert!.run(...cols.map((col) => (call as any)[col] ?? null))
      }
    })()
  }

  async getForSymbols(
    callerIds: string[],
  ): Promise<IndexedSymbolCall['Select'][]> {
    if (!callerIds.length) return []
    return this.db
      .select()
      .from(schema.symbol_calls)
      .where(inArray(schema.symbol_calls.caller_id, callerIds))
  }

  async getUnresolved(): Promise<IndexedSymbolCall['Select'][]> {
    return this.db
      .select()
      .from(schema.symbol_calls)
      .where(
        and(
          isNull(schema.symbol_calls.callee_id),
          isNull(schema.symbol_calls.imports_id),
          isNotNull(schema.symbol_calls.call_line),
        ),
      )
      .orderBy(
        schema.symbol_calls.caller_file_path,
        schema.symbol_calls.call_line,
      )
  }

  async updateCalleeId(callId: string, calleeId: string): Promise<void> {
    await this.db
      .update(schema.symbol_calls)
      .set({ callee_id: calleeId })
      .where(eq(schema.symbol_calls.id, callId))
  }

  async updateImportsId(callId: string, importsId: string): Promise<void> {
    await this.db
      .update(schema.symbol_calls)
      .set({ imports_id: importsId })
      .where(eq(schema.symbol_calls.id, callId))
  }

  async getIdFromName(
    filePathToNameId: Map<string, { name: string; id: string }[]>,
    call: IndexedSymbolCall['Insert'],
  ): Promise<string | null> {
    const candidates = filePathToNameId
      .get(call.caller_file_path)
      ?.filter((entry) => entry.name === call.callee_name)
    if (candidates?.length) return candidates[0]!.id

    const imports = await this.db
      .select()
      .from(schema.imports)
      .where(
        and(
          eq(schema.imports.file_path, call.caller_file_path),
          eq(schema.imports.imported_name, call.callee_name),
        ),
      )

    for (const imp of imports) {
      const impCandidates = filePathToNameId
        .get(imp.module_path)
        ?.filter((entry) => entry.name === call.callee_name)
      if (impCandidates?.length) return impCandidates[0]!.id
    }

    return null
  }

  async getCallers(symbolName: string): Promise<DirectCaller[]> {
    return this.sqlite
      .prepare(
        `SELECT DISTINCT s.file_path AS callerFile, s.name AS callerName, s.line
         FROM symbol_calls sc
         JOIN symbols callee ON callee.name = ?
         JOIN symbols s ON s.id = sc.caller_id
         WHERE sc.callee_id = callee.id OR sc.callee_name = ?
         ORDER BY s.file_path, s.line`,
      )
      .all(symbolName, symbolName) as DirectCaller[]
  }

  async getCallersNested(symbolName: string): Promise<NestedCaller[]> {
    return this.sqlite
      .prepare(
        `SELECT DISTINCT s.file_path AS callerFile, s.name AS callerName, s.line,
                child.name AS childName, child.file_path AS childFilePath, child.line AS childLine
         FROM symbol_calls sc
         JOIN symbols t ON t.name = ? COLLATE NOCASE
         JOIN symbols s ON s.id = sc.caller_id
         LEFT JOIN symbols child ON child.parent_id = t.id
                                 AND (sc.callee_id = child.id OR sc.callee_name = child.name COLLATE NOCASE)
         WHERE (sc.callee_id = t.id OR sc.callee_name = t.name COLLATE NOCASE)
            OR child.id IS NOT NULL
         ORDER BY s.file_path, s.line`,
      )
      .all(symbolName) as NestedCaller[]
  }
}
