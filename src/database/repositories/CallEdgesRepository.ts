import type { Database, Statement } from 'bun:sqlite'
import * as schema from '../schemas'
import {
  getColumns,
  inArray,
  eq,
  and,
  notInArray,
  isNotNull,
  SQL,
  isNull,
} from 'drizzle-orm'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import type { DirectCaller, NestedCaller, OutboundCallEdge } from '../types'

/** Manages a collection of call edges for dependency tracking within an application. Enables analysis of how different components or functions interact with each other. */
export class CallEdgesRepository {
  private callEdgesInsert: Statement | null = null
  private callEdgesGetCallers: Statement | null = null
  private callEdgesGetCallersNested: Statement | null = null
  private callEdgesGetCallersNestedById: Statement | null = null

  /** Initializes a new instance of CallEdgesRepository with the provided SQLite database. */
  constructor(
    private sqlite: Database,
    private db: SQLiteBunDatabase<typeof schema>,
  ) {}

  /** Initializes the SQLite prepared statement for inserting call edge data. */
  initStatements() {
    const cols = Object.keys(getColumns(schema.call_edges))
    this.callEdgesInsert = this.sqlite.prepare(
      `INSERT INTO call_edges (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
    this.callEdgesGetCallers = this.sqlite.prepare(
      `SELECT DISTINCT s.file_path AS callerFile, s.name AS callerName, s.line, s.id AS callerId
         FROM call_edges ce
         JOIN call_sites cs ON cs.id = ce.call_site_id
         JOIN symbols callee ON callee.name = ?
         JOIN symbols s ON s.id = ce.caller_id
         WHERE ce.callee_id = callee.id OR cs.callee_name = ?
         ORDER BY s.file_path, s.line`,
    )
    this.callEdgesGetCallersNested = this.sqlite.prepare(
      `SELECT DISTINCT s.file_path AS callerFile, s.name AS callerName, s.line, s.id AS callerId,
                child.name AS childName, child.file_path AS childFilePath, child.line AS childLine
         FROM call_edges ce
         JOIN call_sites cs ON cs.id = ce.call_site_id
         JOIN symbols t ON t.name = ? COLLATE NOCASE
         JOIN symbols s ON s.id = ce.caller_id
         LEFT JOIN symbols child ON child.parent_id = t.id
                                 AND (ce.callee_id = child.id OR cs.callee_name = child.name COLLATE NOCASE)
         WHERE (ce.callee_id = t.id OR cs.callee_name = t.name COLLATE NOCASE)
            OR child.id IS NOT NULL
         ORDER BY s.file_path, s.line`,
    )
    this.callEdgesGetCallersNestedById = this.sqlite.prepare(
      `SELECT DISTINCT s.file_path AS callerFile, s.name AS callerName, s.line, s.id AS callerId,
                child.name AS childName, child.file_path AS childFilePath, child.line AS childLine
         FROM call_edges ce
         JOIN call_sites cs ON cs.id = ce.call_site_id
         JOIN symbols t ON t.id = ?
         JOIN symbols s ON s.id = ce.caller_id
         LEFT JOIN symbols child ON child.parent_id = t.id
                                 AND (ce.callee_id = child.id OR cs.callee_name = child.name COLLATE NOCASE)
         WHERE (ce.callee_id = t.id OR cs.callee_name = t.name COLLATE NOCASE)
            OR child.id IS NOT NULL
         ORDER BY s.file_path, s.line`,
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

  /** Retrieves all call edges whose caller is one of the given symbol ids. */
  async getForCallers(
    callerIds: string[],
  ): Promise<schema.IndexedCallEdge['Select'][]> {
    if (!callerIds.length) return []
    return this.db
      .select()
      .from(schema.call_edges)
      .where(inArray(schema.call_edges.caller_id, callerIds))
  }

  /** Retrieves all call edges that resolve to one of the given callee symbol ids. */
  async getForCallees(
    calleeIds: string[],
  ): Promise<schema.IndexedCallEdge['Select'][]> {
    if (!calleeIds.length) return []
    return this.db
      .select()
      .from(schema.call_edges)
      .where(inArray(schema.call_edges.callee_id, calleeIds))
  }

  /**
   * Retrieves outbound call edges (joined with their call sites) for a set of
   * caller symbol ids. This is the primary API for traversing the call graph
   * outbound (what a symbol calls).
   */
  async getOutboundForSymbols(
    callerIds: string[],
  ): Promise<OutboundCallEdge[]> {
    if (!callerIds.length) return []
    const placeholders = callerIds.map(() => '?').join(',')
    return this.sqlite
      .prepare(
        `SELECT ce.caller_id, ce.callee_id, ce.imports_id, ce.target_kind, ce.resolution_source,
                cs.callee_name, cs.call_line, cs.call_column, cs.call_text, cs.docstring
         FROM call_edges ce
         JOIN call_sites cs ON cs.id = ce.call_site_id
         WHERE ce.caller_id IN (${placeholders})
         ORDER BY cs.caller_file_path, cs.call_line`,
      )
      .all(...callerIds)
      .map((row: any) => ({
        ...row,
        is_lang_feature: row.target_kind === schema.CallTargetKind.Builtin,
      })) as OutboundCallEdge[]
  }

  /** Retrieves all direct callers of a given symbol by name. */
  async getCallers(symbolName: string): Promise<DirectCaller[]> {
    return this.callEdgesGetCallers!.all(
      symbolName,
      symbolName,
    ) as DirectCaller[]
  }

  /** Retrieves all nested callers of a given symbol by name, including indirect call relationships. */
  async getCallersNested(symbolName: string): Promise<NestedCaller[]> {
    const callers = this.callEdgesGetCallersNested!.all(
      symbolName,
    ) as NestedCaller[]

    return callers.filter((caller) => caller.callerName !== '<module>')
  }

  /** Retrieves all nested callers of a given symbol by its unique identifier. */
  async getCallersNestedById(symbolId: string): Promise<NestedCaller[]> {
    const callers = this.callEdgesGetCallersNestedById!.all(
      symbolId,
    ) as NestedCaller[]

    return callers.filter((caller) => caller.callerName !== '<module>')
  }

  async getDependencyFilesForFilePaths(
    filePaths: string[],
  ): Promise<{ file_path: string }[]> {
    const calleeFiles = await this.db
      .selectDistinct({ file_path: schema.symbols.file_path })
      .from(schema.call_edges)
      .innerJoin(
        schema.call_sites,
        eq(schema.call_sites.id, schema.call_edges.call_site_id),
      )
      .innerJoin(
        schema.symbols,
        eq(schema.symbols.id, schema.call_edges.callee_id),
      )
      .where(
        and(
          inArray(schema.call_sites.caller_file_path, filePaths),
          notInArray(schema.symbols.file_path, filePaths),
        ),
      )

    return calleeFiles
  }

  async getAllEdgesWithSiteInfo(forUnresolved?: boolean): Promise<
    {
      caller_id: string
      callee_id: string | null
      callee_name: string
      caller_file_path: string
    }[]
  > {
    const condition: SQL = forUnresolved
      ? isNull(schema.call_edges.call_site_id)
      : isNotNull(schema.call_edges.call_site_id)
    return this.db
      .select({
        caller_id: schema.call_edges.caller_id,
        callee_id: schema.call_edges.callee_id,
        callee_name: schema.call_sites.callee_name,
        caller_file_path: schema.call_sites.caller_file_path,
      })
      .from(schema.call_edges)
      .innerJoin(
        schema.call_sites,
        eq(schema.call_sites.id, schema.call_edges.call_site_id),
      )
      .where(condition)
  }

  async getAllWithCalleeIds(): Promise<
    { callee: string | null; caller: string }[]
  > {
    const rows = await this.db
      .select({
        callee: schema.call_edges.callee_id,
        caller: schema.call_edges.caller_id,
      })
      .from(schema.call_edges)
      .where(isNotNull(schema.call_edges.callee_id))

    return rows
  }
}
