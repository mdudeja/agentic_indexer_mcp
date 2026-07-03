import { Database, Statement } from 'bun:sqlite'
import { getColumns } from 'drizzle-orm'
import * as schema from '../schemas'
import type { SymbolRepository } from './SymbolRepository'
import type { CallRepository } from './CallRepository'

/** A class managing database interactions and operations related to exceptions and environment variables, providing functionality to upsert records and retrieve information linked to specific symbols. */
export class AnalysisRepository {
  private exceptionDelete: Statement | null = null
  private exceptionInsert: Statement | null = null
  private envVarDelete: Statement | null = null
  private envVarInsert: Statement | null = null

  /** Initializes an object with dependencies for managing database interactions and symbol/call repositories. */
  constructor(
    private sqlite: Database,
    private symbols: SymbolRepository,
    private calls: CallRepository,
  ) {}

  /** Initializes prepared SQL statements for database operations related to exceptions and environment variables. */
  initStatements() {
    const excCols = Object.keys(getColumns(schema.exceptions))
    this.exceptionDelete = this.sqlite.prepare(
      `DELETE FROM exceptions WHERE file_path = ?`,
    )
    this.exceptionInsert = this.sqlite.prepare(
      `INSERT INTO exceptions (${excCols.join(',')}) VALUES (${excCols.map(() => '?').join(',')})`,
    )

    const envCols = Object.keys(getColumns(schema.env_vars))
    this.envVarDelete = this.sqlite.prepare(
      `DELETE FROM env_vars WHERE file_path = ?`,
    )
    this.envVarInsert = this.sqlite.prepare(
      `INSERT INTO env_vars (${envCols.join(',')}) VALUES (${envCols.map(() => '?').join(',')})`,
    )
  }

  /** "Upserts exception entries by deleting any existing records for each file path and then inserting the new exceptions." */
  async upsertExceptions(
    exceptionsData: Array<typeof schema.exceptions.$inferInsert>,
  ): Promise<void> {
    if (
      !exceptionsData.length ||
      !this.exceptionDelete ||
      !this.exceptionInsert
    )
      return

    const cols = Object.keys(getColumns(schema.exceptions))
    this.sqlite.transaction(() => {
      const uniqueFiles = [...new Set(exceptionsData.map((e) => e.file_path))]
      uniqueFiles.forEach((f) => this.exceptionDelete!.run(f))
      exceptionsData.forEach((item) => {
        this.exceptionInsert!.run(
          ...cols.map((col) => (item as any)[col] ?? null),
        )
      })
    })()
  }

  /** Updates or inserts environment variable data based on file paths, ensuring existing entries are replaced and new ones are added where necessary. */
  async upsertEnvVars(
    envVarsData: Array<typeof schema.env_vars.$inferInsert>,
  ): Promise<void> {
    if (!envVarsData.length || !this.envVarDelete || !this.envVarInsert) return

    const cols = Object.keys(getColumns(schema.env_vars))
    this.sqlite.transaction(() => {
      const uniqueFiles = [...new Set(envVarsData.map((e) => e.file_path))]
      uniqueFiles.forEach((f) => this.envVarDelete!.run(f))
      envVarsData.forEach((item) => {
        this.envVarInsert!.run(...cols.map((col) => (item as any)[col] ?? null))
      })
    })()
  }

  /** Retrieves all exceptions from the database, including their associated symbol names, file paths, line numbers, and exception types. */
  async getAllExceptions(): Promise<
    Array<{
      symbol_name: string
      file_path: string
      line: number
      exception_type: string
    }>
  > {
    const exceptions = this.sqlite
      .prepare(`SELECT * from exceptions ORDER BY file_path, line`)
      .all() as Array<schema.IndexedException['Select']>

    const symbolIds = [...new Set(exceptions.map((e) => e.symbol_id))]
    const symbols = await this.symbols.getSymbolsByIds(symbolIds)
    const symbolMap = new Map(symbols.map((s) => [s.id, s.name]))

    return exceptions.map((e) => ({
      symbol_name: symbolMap.get(e.symbol_id) ?? 'Unknown',
      file_path: e.file_path,
      line: e.line,
      exception_type: e.exception_type,
    }))
  }

  /** Retrieves all environment variables from the database, including their associated symbol names, file paths, line numbers, and variable names. */
  async getAllEnvVars(): Promise<
    Array<{
      symbol_name: string
      file_path: string
      line: number
      env_var_name: string
    }>
  > {
    const envVars = this.sqlite
      .prepare(`SELECT * from env_vars ORDER BY file_path, line`)
      .all() as Array<schema.IndexedEnvVar['Select']>

    const symbolIds = [...new Set(envVars.map((e) => e.symbol_id))]
    const symbols = await this.symbols.getSymbolsByIds(symbolIds)
    const symbolMap = new Map(symbols.map((s) => [s.id, s.name]))

    return envVars.map((e) => ({
      symbol_name: symbolMap.get(e.symbol_id) ?? 'Unknown',
      file_path: e.file_path,
      line: e.line,
      env_var_name: e.name,
    }))
  }

  /** Retrieves all exceptions associated with a specific symbol, detailing their occurrence locations and types. */
  async getExceptionsBubbleUp(symbolName: string): Promise<
    Array<{
      symbol_name: string
      file_path: string
      line: number
      exception_type: string
    }>
  > {
    const ids = await this.getReachableSymbolIds(symbolName)
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.sqlite
      .prepare(
        `SELECT s.name AS symbol_name, e.file_path, e.line, e.exception_type
         FROM exceptions e
         JOIN symbols s ON e.symbol_id = s.id
         WHERE e.symbol_id IN (${placeholders})
         ORDER BY e.file_path, e.line`,
      )
      .all(...ids) as Array<{
      symbol_name: string
      file_path: string
      line: number
      exception_type: string
    }>
  }

  /** Retrieves all environment variables referenced by the specified symbol, including their usage locations in the codebase. */
  async getEnvVarsBubbleUp(symbolName: string): Promise<
    Array<{
      symbol_name: string
      file_path: string
      line: number
      env_var_name: string
    }>
  > {
    const ids = await this.getReachableSymbolIds(symbolName)
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.sqlite
      .prepare(
        `SELECT s.name AS symbol_name, ev.file_path, ev.line, ev.name AS env_var_name
         FROM env_vars ev
         JOIN symbols s ON ev.symbol_id = s.id
         WHERE ev.symbol_id IN (${placeholders})
         ORDER BY ev.file_path, ev.line`,
      )
      .all(...ids) as Array<{
      symbol_name: string
      file_path: string
      line: number
      env_var_name: string
    }>
  }

  /** Identifies all symbol IDs reachable from the given symbol name by traversing outbound calls. */
  private async getReachableSymbolIds(symbolName: string): Promise<string[]> {
    const startSymbols = await this.symbols.getSymbolsByNames([symbolName])
    if (!startSymbols.length) return []

    const subtree = (
      await Promise.all(
        startSymbols.map(async (s) => this.symbols.getSubtree(s.id)),
      )
    ).flat()

    const visited = new Set<string>()
    const queue = startSymbols
      .map((s) => [s.id, s.parent_id])
      .flat()
      .filter(Boolean) as string[]
    const allIds = [...queue, ...subtree.map((s) => s.id)]

    while (queue.length > 0) {
      const currentId = queue.shift()!
      if (visited.has(currentId)) continue
      visited.add(currentId)

      const outboundCalls = await this.calls.getForSymbols([currentId])
      for (const call of outboundCalls) {
        if (call.callee_id && !visited.has(call.callee_id)) {
          queue.push(call.callee_id)
          allIds.push(call.callee_id)
        }
      }
    }

    return allIds
  }
}
