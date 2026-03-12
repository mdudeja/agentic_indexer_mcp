import { Database, Statement } from 'bun:sqlite'
import { drizzle, type SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import { eq, like, SQL, and, getColumns } from 'drizzle-orm'
import * as schema from './schemas'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import type { IndexedSymbol, IndexedFile, SymbolKind } from '../indexer/types'
import { resolvePath } from 'src/utils/paths'
import { logDebug } from 'src/utils/logger'
import { getNowMillis } from 'src/utils/datetime'

export class IndexerDB {
  private db: SQLiteBunDatabase<typeof schema>

  private dbInited: boolean = false
  private dbFilePath?: string
  private static instance: IndexerDB | null = null
  private isMemory: boolean = false
  private sqlite: Database

  private preparedSymbolDelete: Statement | null = null
  private preparedSymbolInsert: Statement | null = null

  private constructor(dbPath: string = ':memory:') {
    this.dbFilePath = dbPath || (process.env.DB_FILE_URL as string)
    this.isMemory = dbPath === ':memory:'

    if (!this.isMemory) {
      const dbDir = dirname(resolvePath(this.dbFilePath))
      if (!existsSync(dbDir)) {
        logDebug(`Creating database directory at ${dbDir}`)
        mkdirSync(dbDir, { recursive: true })
      }
    }

    this.sqlite = new Database(this.dbFilePath, { create: true, strict: true })

    this.sqlite.run('PRAGMA foreign_keys = ON;')
    this.sqlite.run('PRAGMA journal_mode = WAL;')
    this.sqlite.run('PRAGMA synchronous = NORMAL;')

    this.db = drizzle({
      client: this.sqlite,
      schema,
    })
  }

  public static getInstance(dbPath: string = ':memory:') {
    if (!IndexerDB.instance || IndexerDB.instance.dbFilePath !== dbPath) {
      IndexerDB.instance = new IndexerDB(dbPath)
    }
    return IndexerDB.instance
  }

  getDb() {
    return this.db
  }

  async init() {
    if (this.dbInited) return

    // Run Drizzle migrations
    const migrationsDir = resolvePath(
      process.env.DB_MIGRATIONS_DIR || './drizzle_migrations',
    )
    migrate(this.db, { migrationsFolder: migrationsDir })

    this.preparedSymbolDelete = this.sqlite.prepare(
      `DELETE FROM symbols WHERE file_path = ?`,
    )

    const columnNames = Object.keys(getColumns(schema.symbols))
    const insertPlaceholders = columnNames.map(() => '?').join(',')

    this.preparedSymbolInsert = this.sqlite.prepare(
      `INSERT INTO symbols (${columnNames.join(',')}) VALUES (${insertPlaceholders})`,
    )

    this.dbInited = true
    logDebug('Database migrations applied')
  }

  async upsertFile(file: IndexedFile['Insert']) {
    return this.db
      .insert(schema.files)
      .values(file)
      .onConflictDoUpdate({
        target: schema.files.path,
        set: {
          hash: file.hash,
          indexedAt: getNowMillis(),
          language: file.language,
        },
      })
  }

  async getFileHash(path: string): Promise<string | null> {
    const result = await this.db
      .select({ hash: schema.files.hash })
      .from(schema.files)
      .where(eq(schema.files.path, path))
      .limit(1)

    return result.length > 0 ? result[0]!.hash : null
  }

  async deleteFile(path: string) {
    // Cascades to symbols if ON DELETE CASCADE is set up correctly in schema
    return this.db.delete(schema.files).where(eq(schema.files.path, path))
  }

  async upsertSymbols(symbolsData: IndexedSymbol['Insert'][]) {
    if (
      symbolsData.length === 0 ||
      !this.preparedSymbolDelete ||
      !this.preparedSymbolInsert
    )
      return

    return this.sqlite.transaction(() => {
      const uniqueFiles = [...new Set(symbolsData.map((s) => s.filePath))]
      uniqueFiles.forEach((f) => this.preparedSymbolDelete?.run(f))

      const withExported = symbolsData.map((s) => ({
        ...s,
        exported: s.exported ? true : false,
      }))

      withExported.forEach((item) => this.preparedSymbolInsert?.run(item))
    })()
  }

  async searchSymbols(
    queryStr: string,
    kind?: SymbolKind | 'all',
    filePattern?: string,
    limitVal: number = 20,
  ) {
    // Convert * to % for SQL LIKE
    const sqlPattern = queryStr.replace(/\*/g, '%')

    const conditions: SQL[] = [like(schema.symbols.name, sqlPattern)]

    if (kind && kind !== 'all') {
      conditions.push(eq(schema.symbols.kind, kind))
    }

    if (filePattern) {
      const fileSqlPattern = filePattern.replace(/\*/g, '%')
      conditions.push(like(schema.symbols.filePath, fileSqlPattern))
    }

    return this.db
      .select()
      .from(schema.symbols)
      .where(and(...conditions))
      .limit(limitVal)
  }

  async getFileSummary(path: string) {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.filePath, path))
      .orderBy(schema.symbols.line)
  }

  async getDefinition(id: string) {
    const result = await this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.id, id))
      .limit(1)

    return result[0] || null
  }

  async getDefinitionByName(name: string, path: string) {
    const result = await this.db
      .select()
      .from(schema.symbols)
      .where(
        and(eq(schema.symbols.name, name), eq(schema.symbols.filePath, path)),
      )
      .limit(1)

    return result[0] || null
  }

  async clear() {
    await this.db.delete(schema.symbols)
    await this.db.delete(schema.files)
  }
}
