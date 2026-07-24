import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import { eq, like, and, inArray } from 'drizzle-orm'
import * as schema from '../schemas'
import type { IndexedFile } from '../schemas'
import { getNowMillis } from 'src/utils/datetime'
import type { EmbeddingRepository } from './EmbeddingRepository'
import { collapseRepeatedDbWildcards } from '.'

/** A class managing file storage and embedding associations in a database. */
export class FileRepository {
  /** Initializes an instance of the class with a database connection and embedding capabilities. */
  constructor(
    private db: SQLiteBunDatabase<typeof schema>,
    private embeddings: EmbeddingRepository,
  ) {}

  /** Inserts a new file or updates an existing one if it already exists based on its path. */
  async upsert(file: IndexedFile['Insert']) {
    return this.db
      .insert(schema.files)
      .values(file)
      .onConflictDoUpdate({
        target: schema.files.path,
        set: {
          hash: file.hash,
          indexed_at: getNowMillis(),
          language: file.language,
          estimated_tokens: file.estimated_tokens,
        },
      })
  }

  /** Get the hash value associated with a file identified by its path. If no file is found, returns null. */
  async getHash(path: string): Promise<string | null> {
    const result = await this.db
      .select({ hash: schema.files.hash })
      .from(schema.files)
      .where(eq(schema.files.path, path))
      .limit(1)
    return result[0]?.hash ?? null
  }

  /** "Retrieves symbols from a specified file, ordered by their occurrence within the code." */
  async getSummary(path: string) {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.file_path, path))
      .orderBy(schema.symbols.line)
  }

  /** "Retrieves all selected files." */
  async getAll(): Promise<IndexedFile['Select'][]> {
    return this.db.select().from(schema.files)
  }

  async search(
    query: string,
    language?: string,
    limit?: number,
    file_pattern?: string,
  ): Promise<IndexedFile['Select'][]> {
    return this.db
      .select()
      .from(schema.files)
      .where(
        and(
          like(
            schema.files.path,
            collapseRepeatedDbWildcards(`%${query.replace(/\*/g, '%')}%`),
          ),
          language ? eq(schema.files.language, language) : undefined,
          file_pattern
            ? like(
                schema.files.path,
                collapseRepeatedDbWildcards(
                  `%${file_pattern.replace(/\*/g, '%')}%`,
                ),
              )
            : undefined,
        ),
      )
      .orderBy(schema.files.path)
      .limit(limit ?? 20)
  }

  /** "Retrieves a single file entry by its path." */
  async getByPath(path: string): Promise<IndexedFile['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.path, path))
      .limit(1)
    return result[0] ?? null
  }

  /** "Searches for files based on a partial name or path." */
  async getByPartialNameOrPath(
    partialNameOrPath: string,
  ): Promise<IndexedFile['Select'][]> {
    return this.db
      .select()
      .from(schema.files)
      .where(
        like(
          schema.files.path,
          collapseRepeatedDbWildcards(
            `%${partialNameOrPath.replace(/\*/g, '%')}%`,
          ),
        ),
      )
      .orderBy(schema.files.path)
  }

  /** Delete all data (embeddings and database records) associated with the specified file path. */
  async delete(path: string) {
    this.embeddings.deleteForFile(path)
    return this.db.delete(schema.files).where(eq(schema.files.path, path))
  }

  /** "Estimates the total number of tokens for specified file paths by querying the database and summing their token estimates." */
  async getEstimatedTokensForPaths(paths: string[]): Promise<number> {
    const files = await this.db
      .select({ estimated_tokens: schema.files.estimated_tokens })
      .from(schema.files)
      .where(paths.length > 0 ? inArray(schema.files.path, paths) : and())
    return files.reduce((sum, f) => sum + (f.estimated_tokens ?? 0), 0)
  }
}
