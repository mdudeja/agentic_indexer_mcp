import { Database, Statement } from 'bun:sqlite'
import { getColumns } from 'drizzle-orm'
import * as schema from '../schemas'
import type { ToolUsageRecord } from '../schemas'

/** Records and analyzes the usage of tools, tracking metrics such as token usage and providing summarized insights. */
export class ToolUsageRepository {
  private toolUsageInsert: Statement | null = null

  /** Initializes a new instance of the class with the specified SQLite database. */
  constructor(private sqlite: Database) {}

  /** Initializes a prepared SQL statement for inserting tool usage data into the database. */
  initStatements() {
    const cols = Object.keys(getColumns(schema.tool_usage))
    this.toolUsageInsert = this.sqlite.prepare(
      `INSERT INTO tool_usage (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
  }

  /** "Records the usage of a tool by inserting data into a database." */
  async record(data: ToolUsageRecord['Insert']): Promise<void> {
    const cols = Object.keys(getColumns(schema.tool_usage))
    this.toolUsageInsert?.run(...cols.map((col) => (data as any)[col] ?? null))
  }

  /** Calculates and returns summarized token usage savings, including total metrics and per-tool breakdowns. */
  getTokenSavings(): {
    total_calls: number
    total_tokens_saved: number
    total_source_tokens: number
    total_response_tokens: number
    by_tool: Array<{
      tool_name: string
      calls: number
      tokens_saved: number
      source_tokens: number
      response_tokens: number
    }>
  } {
    const totals = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS total_calls,
                SUM(tokens_saved) AS total_tokens_saved,
                SUM(source_tokens) AS total_source_tokens,
                SUM(response_tokens) AS total_response_tokens
         FROM tool_usage`,
      )
      .get() as any

    const byTool = this.sqlite
      .prepare(
        `SELECT tool_name,
                COUNT(*) AS calls,
                SUM(tokens_saved) AS tokens_saved,
                SUM(source_tokens) AS source_tokens,
                SUM(response_tokens) AS response_tokens
         FROM tool_usage
         GROUP BY tool_name
         ORDER BY tokens_saved DESC`,
      )
      .all() as any[]

    return {
      total_calls: totals.total_calls ?? 0,
      total_tokens_saved: totals.total_tokens_saved ?? 0,
      total_source_tokens: totals.total_source_tokens ?? 0,
      total_response_tokens: totals.total_response_tokens ?? 0,
      by_tool: byTool,
    }
  }
}
