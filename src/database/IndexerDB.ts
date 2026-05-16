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
  IndexerConfig,
} from '../config/types'
import { resolvePath } from 'src/utils/paths'
import { logDebug } from 'src/utils/logger'
import { getNowMillis } from 'src/utils/datetime'
import { AppStateManager } from 'src/state'

export class IndexerDB {
  private db: SQLiteBunDatabase<typeof schema>
  private config: IndexerConfig

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
      : resolvePath(dbPath || (import.meta.env.DB_FILE_URL as string))

    if (!this.isMemory) {
      const dbDir = dirname(this.dbFilePath!)
      if (!existsSync(dbDir)) {
        logDebug(`Creating database directory at ${dbDir}`)
        mkdirSync(dbDir, { recursive: true })
      }
    }

    this.config = AppStateManager.getInstance().getItem('config') ?? {
      enabled: false,
      languages: {},
      extnToLangMap: {},
      ignore_patterns: [],
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
      import.meta.env.DB_MIGRATIONS_DIR || './drizzle_migrations',
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
      `INSERT INTO symbol_calls (id, caller_id, callee_name, callee_id, language_name, call_line, call_column, caller_file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

    if (calleeNames.length === 0) {
      logDebug('No calls to upsert, skipping callee resolution')
      return
    }

    const allLanguages = [...new Set(callsData.map((c) => c.language_name))]
    const relevantLanguageConfig = Object.entries(this.config.languages).filter(
      ([lang]) => allLanguages.includes(lang),
    )
    const CALLABLE_KINDS = relevantLanguageConfig.flatMap(
      ([, cfg]) => cfg.treesitter.lists.callable_kinds,
    )

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

    return this.sqlite.transaction(() => {
      for (const call of callsData) {
        const calleeId = nameToId.get(call.callee_name) ?? null
        this.preparedCallInsert?.run(
          call.id,
          call.caller_id,
          call.callee_name,
          calleeId,
          call.language_name,
          call.call_line ?? null,
          call.call_column ?? null,
          call.caller_file_path,
        )
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
      .where(like(schema.imports.module_path, pattern))
  }

  async getSymbolsForFile(path: string): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.file_path, path))
      .orderBy(schema.symbols.line)
  }

  async getFileByPath(path: string): Promise<IndexedFile['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.path, path))
      .limit(1)

    return result[0] || null
  }

  async getAllFiles(): Promise<IndexedFile['Select'][]> {
    return this.db.select().from(schema.files)
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

  async getUnresolvedCalls(): Promise<
    Array<{
      id: string
      caller_id: string
      callee_name: string
      call_line: number
      call_column: number
      caller_file: string
    }>
  > {
    return this.sqlite
      .prepare(
        `SELECT sc.id, sc.caller_id, sc.callee_name,
                sc.call_line, sc.call_column, s.file_path AS caller_file
         FROM symbol_calls sc
         JOIN symbols s ON s.id = sc.caller_id
         WHERE sc.callee_id IS NULL
           AND sc.call_line IS NOT NULL
         ORDER BY s.file_path`,
      )
      .all() as any[]
  }

  async updateCalleeId(callId: string, calleeId: string): Promise<void> {
    await this.db
      .update(schema.symbol_calls)
      .set({ callee_id: calleeId })
      .where(eq(schema.symbol_calls.id, callId))
  }

  async getSymbolAtLocation(
    filePath: string,
    line: number,
  ): Promise<IndexedSymbol['Select'] | null> {
    const exact = await this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.file_path, filePath),
          eq(schema.symbols.line, line),
        ),
      )
      .limit(1)
    if (exact[0]) return exact[0]

    // Fallback: match by line only; return if unambiguous
    const byLine = await this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.file_path, filePath),
          eq(schema.symbols.line, line),
        ),
      )
    return byLine.length === 1 ? byLine[0]! : null
  }

  async updateSymbolTypeInfo(
    symbolId: string,
    parametersJson: string,
    returnType: string,
  ): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({ parameters_json: parametersJson, return_type: returnType })
      .where(eq(schema.symbols.id, symbolId))
  }

  async getCallers(
    symbolName: string,
  ): Promise<Array<{ callerFile: string; callerName: string; line: number }>> {
    return this.sqlite
      .prepare(
        `SELECT DISTINCT s.file_path AS callerFile, s.name AS callerName, s.line
         FROM symbol_calls sc
         JOIN symbols callee ON callee.name = ?
         JOIN symbols s ON s.id = sc.caller_id
         WHERE sc.callee_id = callee.id OR sc.callee_name = ?
         ORDER BY s.file_path, s.line`,
      )
      .all(symbolName, symbolName) as any[]
  }

  async clear() {
    await this.db.delete(schema.symbols)
    await this.db.delete(schema.imports)
    await this.db.delete(schema.files)
    await this.db.delete(schema.symbol_calls)
  }
}
