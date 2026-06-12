import { Database, Statement } from 'bun:sqlite'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import { eq, like, and, getColumns } from 'drizzle-orm'
import * as schema from '../schemas'
import type { IndexedImport } from '../schemas'

export class ImportRepository {
  private importDelete: Statement | null = null
  private importInsert: Statement | null = null

  constructor(
    private sqlite: Database,
    private db: SQLiteBunDatabase<typeof schema>,
  ) {}

  initStatements() {
    const cols = Object.keys(getColumns(schema.imports))
    this.importDelete = this.sqlite.prepare(
      `DELETE FROM imports WHERE file_path = ?`,
    )
    this.importInsert = this.sqlite.prepare(
      `INSERT INTO imports (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
  }

  async upsert(importsData: IndexedImport['Insert'][]): Promise<void> {
    if (!importsData.length || !this.importDelete || !this.importInsert) return

    const cols = Object.keys(getColumns(schema.imports))
    this.sqlite.transaction(() => {
      const uniqueFiles = [...new Set(importsData.map((m) => m.file_path))]
      uniqueFiles.forEach((f) => this.importDelete!.run(f))
      importsData.forEach((item) => {
        this.importInsert!.run(...cols.map((col) => (item as any)[col] ?? null))
      })
    })()
  }

  async getImporters(
    moduleNamePattern: string,
  ): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .where(
        like(
          schema.imports.module_path,
          `%${moduleNamePattern.replace(/\*/g, '%')}%`,
        ),
      )
  }

  async getById(id: string): Promise<IndexedImport['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, id))
      .limit(1)
    return result[0] ?? null
  }

  async getByName(importedName: string): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.imported_name, importedName))
  }

  async getByNameAndFile(
    importedName: string,
    filePath: string,
  ): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .where(
        and(
          eq(schema.imports.imported_name, importedName),
          eq(schema.imports.file_path, filePath),
        ),
      )
      .orderBy(schema.imports.module_path)
  }

  async getAll(): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .orderBy(schema.imports.file_path, schema.imports.module_path)
  }
}
