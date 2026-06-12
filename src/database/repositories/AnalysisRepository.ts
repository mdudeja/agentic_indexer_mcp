import { Database, Statement } from 'bun:sqlite'
import { getColumns } from 'drizzle-orm'
import * as schema from '../schemas'
import type { SymbolRepository } from './SymbolRepository'
import type { CallRepository } from './CallRepository'

export class AnalysisRepository {
  private exceptionDelete: Statement | null = null
  private exceptionInsert: Statement | null = null
  private envVarDelete: Statement | null = null
  private envVarInsert: Statement | null = null

  constructor(
    private sqlite: Database,
    private symbols: SymbolRepository,
    private calls: CallRepository,
  ) {}

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

  private async getReachableSymbolIds(symbolName: string): Promise<string[]> {
    const startSymbols = await this.symbols.getSymbolsByNames([symbolName])
    if (!startSymbols.length) return []

    const visited = new Set<string>()
    const queue = startSymbols.map((s) => s.id)
    const allIds = [...queue]

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
