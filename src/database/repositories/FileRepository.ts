import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import { eq, like, and, inArray } from 'drizzle-orm'
import * as schema from '../schemas'
import type { IndexedFile } from '../schemas'
import { getNowMillis } from 'src/utils/datetime'
import type { EmbeddingRepository } from './EmbeddingRepository'

export class FileRepository {
  constructor(
    private db: SQLiteBunDatabase<typeof schema>,
    private embeddings: EmbeddingRepository,
  ) {}

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

  async getHash(path: string): Promise<string | null> {
    const result = await this.db
      .select({ hash: schema.files.hash })
      .from(schema.files)
      .where(eq(schema.files.path, path))
      .limit(1)
    return result[0]?.hash ?? null
  }

  async getSummary(path: string) {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.file_path, path))
      .orderBy(schema.symbols.line)
  }

  async getAll(): Promise<IndexedFile['Select'][]> {
    return this.db.select().from(schema.files)
  }

  async getByPath(path: string): Promise<IndexedFile['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.path, path))
      .limit(1)
    return result[0] ?? null
  }

  async getByPartialNameOrPath(
    partialNameOrPath: string,
  ): Promise<IndexedFile['Select'][]> {
    return this.db
      .select()
      .from(schema.files)
      .where(
        like(schema.files.path, `%${partialNameOrPath.replace(/\*/g, '%')}%`),
      )
      .orderBy(schema.files.path)
  }

  async delete(path: string) {
    this.embeddings.deleteForFile(path)
    return this.db.delete(schema.files).where(eq(schema.files.path, path))
  }

  async getEstimatedTokensForPaths(paths: string[]): Promise<number> {
    const files = await this.db
      .select({ estimated_tokens: schema.files.estimated_tokens })
      .from(schema.files)
      .where(paths.length > 0 ? inArray(schema.files.path, paths) : and())
    return files.reduce((sum, f) => sum + (f.estimated_tokens ?? 0), 0)
  }
}
