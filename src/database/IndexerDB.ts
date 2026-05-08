import { Database, Statement } from 'bun:sqlite'
import { drizzle, type SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import { eq, like, SQL, and, getColumns, inArray } from 'drizzle-orm'
import * as schema from './schemas'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { SymbolKind } from '../config/types'
import type {
  IndexedSymbol,
  IndexedFile,
  IndexedImport,
  IndexedSymbolCall,
} from '../config/types'
import { resolvePath } from 'src/utils/paths'
import { logDebug } from 'src/utils/logger'
import { getNowMillis } from 'src/utils/datetime'

// Kinds that map to callable symbols — used to prefer e.g. arrowFunction over const
// when both share the same name (e.g. `const foo = () => {}`).
const CALLABLE_KINDS: SymbolKind[] = [SymbolKind.function, SymbolKind.method, SymbolKind.arrowFunction]

export class IndexerDB {
  private db: SQLiteBunDatabase<typeof schema>

  private dbInited: boolean = false
  private dbFilePath?: string
  private static instance: IndexerDB | null = null
  private isMemory: boolean = false
  private sqlite: Database

  private preparedSymbolDelete: Statement | null = null
  private preparedSymbolInsert: Statement | null = null
  private preparedImportDelete: Statement | null = null
  private preparedImportInsert: Statement | null = null
  private preparedCallInsert: Statement | null = null

  private constructor(dbPath?: string) {
    this.isMemory = dbPath === ':memory:'
    this.dbFilePath = this.isMemory
      ? dbPath
      : resolvePath(dbPath || (process.env.DB_FILE_URL as string))

    if (!this.isMemory) {
      const dbDir = dirname(this.dbFilePath!)
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

  public static getInstance(dbPath?: string) {
    if (
      !IndexerDB.instance ||
      (dbPath !== undefined && IndexerDB.instance.dbFilePath !== dbPath)
    ) {
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

    this.preparedImportDelete = this.sqlite.prepare(
      `DELETE FROM imports WHERE file_path = ?`,
    )
    const importCols = Object.keys(getColumns(schema.imports))
    this.preparedImportInsert = this.sqlite.prepare(
      `INSERT INTO imports (${importCols.join(',')}) VALUES (${importCols.map(() => '?').join(',')})`,
    )

    this.preparedCallInsert = this.sqlite.prepare(
      `INSERT INTO symbol_calls (id, caller_id, callee_name, callee_id) VALUES (?, ?, ?, ?)`,
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
          indexed_at: getNowMillis(),
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
      const uniqueFiles = [...new Set(symbolsData.map((s) => s.file_path))]
      uniqueFiles.forEach((f) => this.preparedSymbolDelete?.run(f))

      const withExported = symbolsData.map((s) => ({
        ...s,
        exported: s.exported ? true : false,
      }))

      const symbolCols = Object.keys(getColumns(schema.symbols))
      withExported.forEach((item) => {
        const args = symbolCols.map((col) => (item as any)[col] ?? null)
        this.preparedSymbolInsert?.run(...args)
      })
    })()
  }

  async upsertCalls(callsData: IndexedSymbolCall['Insert'][]) {
    if (callsData.length === 0 || !this.preparedCallInsert) return

    // Resolve callee names to callable symbol IDs before inserting.
    // Querying only callable kinds ensures that when a name has both a 'const'
    // and an 'arrowFunction' entry, we link to the callable one.
    const calleeNames = [...new Set(callsData.map((c) => c.callee_name))]
    const nameToId = new Map<string, string>()
    if (calleeNames.length > 0) {
      const calleeSymbols = await this.db
        .select({ id: schema.symbols.id, name: schema.symbols.name })
        .from(schema.symbols)
        .where(
          and(
            inArray(schema.symbols.name, calleeNames),
            inArray(schema.symbols.kind, CALLABLE_KINDS),
          ),
        )
      for (const sym of calleeSymbols) {
        if (!nameToId.has(sym.name)) nameToId.set(sym.name, sym.id)
      }
    }

    return this.sqlite.transaction(() => {
      for (const call of callsData) {
        const calleeId = nameToId.get(call.callee_name) ?? null
        this.preparedCallInsert?.run(call.id, call.caller_id, call.callee_name, calleeId)
      }
    })()
  }

  async getCallsForSymbols(
    callerIds: string[],
  ): Promise<IndexedSymbolCall['Select'][]> {
    if (callerIds.length === 0) return []
    return this.db
      .select()
      .from(schema.symbol_calls)
      .where(inArray(schema.symbol_calls.caller_id, callerIds))
  }

  async getSymbolsByIds(ids: string[]): Promise<IndexedSymbol['Select'][]> {
    if (ids.length === 0) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(inArray(schema.symbols.id, ids))
  }

  async upsertImports(importsData: IndexedImport['Insert'][]) {
    if (
      importsData.length === 0 ||
      !this.preparedImportDelete ||
      !this.preparedImportInsert
    )
      return
    return this.sqlite.transaction(() => {
      const uniqueFiles = [...new Set(importsData.map((m) => m.file_path))]
      uniqueFiles.forEach((f) => this.preparedImportDelete?.run(f))
      const importCols = Object.keys(getColumns(schema.imports))
      importsData.forEach((item) => {
        const args = importCols.map((col) => (item as any)[col] ?? null)
        this.preparedImportInsert?.run(...args)
      })
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
      conditions.push(like(schema.symbols.file_path, fileSqlPattern))
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
      .where(eq(schema.symbols.file_path, path))
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
        and(eq(schema.symbols.name, name), eq(schema.symbols.file_path, path)),
      )
      .limit(1)

    return result[0] || null
  }

  async getImporters(moduleNamePattern: string) {
    const pattern = moduleNamePattern.replace(/\*/g, '%')
    return this.db
      .select()
      .from(schema.imports)
      .where(like(schema.imports.module_name, pattern))
  }

  async getSymbolsForFile(path: string): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.file_path, path))
      .orderBy(schema.symbols.line)
  }

  // Fetches a symbol and all its descendants via a recursive parent_id walk.
  // Returns rows ordered by line so the caller can assume source order.
  async getSymbolSubtree(symbolId: string): Promise<IndexedSymbol['Select'][]> {
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE subtree AS (
          SELECT * FROM symbols WHERE id = ?
          UNION ALL
          SELECT s.* FROM symbols s INNER JOIN subtree t ON s.parent_id = t.id
        )
        SELECT * FROM subtree ORDER BY line`,
      )
      .all(symbolId) as any[]

    return rows.map((row) => ({
      ...row,
      exported: Boolean(row.exported),
    })) as IndexedSymbol['Select'][]
  }

  async getAllSymbols(): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  async clear() {
    await this.db.delete(schema.symbols)
    await this.db.delete(schema.imports)
    await this.db.delete(schema.files)
  }
}
