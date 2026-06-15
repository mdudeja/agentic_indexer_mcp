import { Database, Statement } from 'bun:sqlite'
import type { IndexedSymbol } from '../schemas'
import { logError } from 'src/utils/logger'

/** A class providing functionality to manage vector embeddings for symbols within an SQLite database. It handles operations such as inserting, updating, deleting, and searching embeddings. */
export class EmbeddingRepository {
  private vectorInsert: Statement | null = null
  private vectorDelete: Statement | null = null
  private vectorDeleteByFile: Statement | null = null

  /** The constructor initializes an instance of a class with a specified SQLite database. */
  constructor(private sqlite: Database) {}

  /** Initializes prepared SQL statements for vector-related database operations. */
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

  /** Updates or inserts an embedding vector by symbol ID, ensuring any existing entry is replaced with the new one. */
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

  /** Returns symbols from specified files that require embeddings since they lack existing vector representations. */
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

  /** Deletes the embedding associated with the specified symbol ID. */
  async delete(symbolId: string): Promise<void> {
    try {
      this.vectorDelete?.run(symbolId)
    } catch (err) {
      logError(`Failed to delete embedding for symbol ${symbolId}:`, err)
    }
  }

  /** Deletes all embeddings associated with the specified file. */
  deleteForFile(path: string): void {
    try {
      this.vectorDeleteByFile?.run(path)
    } catch (err) {
      logError(`Failed to delete embeddings for file ${path}:`, err)
    }
  }

  /** Searches a vector database for similar items based on an embedding representation. Returns the closest matches up to the specified limit. */
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
