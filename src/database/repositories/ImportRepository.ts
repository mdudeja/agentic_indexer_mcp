import { Database, Statement } from 'bun:sqlite'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import { eq, like, and, getColumns } from 'drizzle-orm'
import * as schema from '../schemas'
import type { IndexedImport } from '../schemas'

/** A class managing import data storage and retrieval using a database. */
export class ImportRepository {
  private importDelete: Statement | null = null
  private importInsert: Statement | null = null

  /** Initializes a new instance with SQLite database dependencies. */
  constructor(
    private sqlite: Database,
    private db: SQLiteBunDatabase<typeof schema>,
  ) {}

  /** Initialize prepared SQL statements for managing import operations. */
  initStatements() {
    const cols = Object.keys(getColumns(schema.imports))
    this.importDelete = this.sqlite.prepare(
      `DELETE FROM imports WHERE file_path = ?`,
    )
    this.importInsert = this.sqlite.prepare(
      `INSERT INTO imports (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
  }

  /** Ensures that the provided import data exists in the database. If records exist, they are updated; if not, new records are inserted. This operation is performed within a transaction to avoid race conditions, ensuring consistency when handling multiple entries from the same file path. */
  async upsert(importsData: IndexedImport['Insert'][]): Promise<void> {
    if (!importsData.length || !this.importDelete || !this.importInsert) return

    const cols = Object.keys(getColumns(schema.imports))
    this.sqlite.transaction(() => {
      const uniqueFiles = [...new Set(importsData.map((m) => m.file_path))]
      uniqueFiles.forEach((f) => this.importDelete!.run(f))
      importsData.forEach((item) => {
        const updatedItem = {
          ...item,
          importedNames: JSON.stringify(item.importedNames),
        }
        const values = cols.map((col) => (updatedItem as any)[col])
        this.importInsert!.run(...values)
      })
    })()
  }

  /** Fetches importers matching a specified module name pattern, supporting wildcard characters (*) in the pattern. */
  async getImporters(
    moduleNamePattern: string,
  ): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .where(
        like(
          schema.imports.resolvedPath,
          `%${moduleNamePattern.replace(/\*/g, '%')}%`,
        ),
      )
  }

  /** Retrieves an import based on its unique identifier. Returns `null` if no import with the specified ID exists. */
  async getById(id: string): Promise<IndexedImport['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, id))
      .limit(1)
    return result[0] ?? null
  }

  /** Retrieves all imports with the specified name. */
  async getByName(importedName: string): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .where(like(schema.imports.importedNames, `%${importedName}%`))
  }

  /** "Retrieves imports that match the specified name and file path." */
  async getByNameAndFile(
    importedName: string,
    filePath: string,
  ): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .where(
        and(
          like(schema.imports.importedNames, `%${importedName}%`),
          eq(schema.imports.file_path, filePath),
        ),
      )
      .orderBy(schema.imports.resolvedPath)
  }

  /** Fetches all import records from the database. */
  async getAll(): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .orderBy(schema.imports.file_path, schema.imports.resolvedPath)
  }
}
