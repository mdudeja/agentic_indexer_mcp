import { Database, Statement } from 'bun:sqlite'
import type { IndexedSymbol } from '../schemas'
import { logError } from 'src/utils/logger'

export class EmbeddingRepository {
  private vectorInsert: Statement | null = null
  private vectorDelete: Statement | null = null
  private vectorDeleteByFile: Statement | null = null

  constructor(private sqlite: Database) {}

  initStatements() {
    this.vectorInsert = this.sqlite.prepare(
      `INSERT INTO vec_symbols (symbol_id, embedding) VALUES (?, ?)`,
    )
    this.vectorDelete = this.sqlite.prepare(
      `DELETE FROM vec_symbols WHERE symbol_id = ?`,
    )
    this.vectorDeleteByFile = this.sqlite.prepare(
      `DELETE FROM vec_symbols WHERE symbol_id IN (SELECT id FROM symbols WHERE file_path = ?)`,
    )
  }

  async upsert(symbolId: string, embedding: number[]): Promise<void> {
    const buffer = Buffer.from(new Float32Array(embedding).buffer)
    try {
      this.sqlite.transaction(() => {
        this.vectorDelete?.run(symbolId)
        this.vectorInsert?.run(symbolId, buffer)
      })()
    } catch (err) {
      logError(`Failed to upsert embedding for symbol ${symbolId}:`, err)
    }
  }

  async getSymbolsNeedingEmbeddings(
    filePaths: string[],
  ): Promise<IndexedSymbol['Select'][]> {
    if (filePaths.length === 0) return []
    try {
      const rows = this.sqlite
        .prepare(
          `SELECT s.* FROM symbols s
           LEFT JOIN vec_symbols v ON s.id = v.symbol_id
           WHERE v.symbol_id IS NULL AND s.file_path IN (${filePaths.map(() => '?').join(',')})`,
        )
        .all(...filePaths) as IndexedSymbol['Select'][]
      return rows.map((row) => ({ ...row, exported: Boolean(row.exported) }))
    } catch (err) {
      logError('Failed to query symbols needing embeddings:', err)
      return []
    }
  }

  async delete(symbolId: string): Promise<void> {
    try {
      this.vectorDelete?.run(symbolId)
    } catch (err) {
      logError(`Failed to delete embedding for symbol ${symbolId}:`, err)
    }
  }

  deleteForFile(path: string): void {
    try {
      this.vectorDeleteByFile?.run(path)
    } catch (err) {
      logError(`Failed to delete embeddings for file ${path}:`, err)
    }
  }

  searchVector(
    queryEmbedding: number[],
    limit: number,
  ): Array<{ symbol_id: string; distance: number }> {
    try {
      const buffer = Buffer.from(new Float32Array(queryEmbedding).buffer)
      return this.sqlite
        .prepare(
          `SELECT symbol_id, distance
           FROM vec_symbols
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(buffer, limit) as Array<{ symbol_id: string; distance: number }>
    } catch (err) {
      logError('Error running semantic query on vec_symbols:', err)
      return []
    }
  }
}
