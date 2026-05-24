import { Database, Statement } from 'bun:sqlite'
import { drizzle, type SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import {
  eq,
  like,
  SQL,
  and,
  getColumns,
  inArray,
  isNull,
  or,
  not,
  isNotNull,
} from 'drizzle-orm'
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

/** Manages an SQLite database for indexing and querying code symbols, files, imports, and call relationships using Drizzle ORM. */
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

  /** Initializes a new IndexerDB instance, optionally using an in-memory or file-based database based on the provided path. Sets up SQLite configuration and initializes the database schema. */
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

  /** Returns the singleton instance of IndexerDB, ensuring only one instance exists per database path. */
  public static getInstance(dbPath?: string) {
    if (
      !IndexerDB.instance ||
      (dbPath !== undefined && IndexerDB.instance.dbFilePath !== dbPath)
    ) {
      IndexerDB.instance = new IndexerDB(dbPath)
    }
    return IndexerDB.instance
  }

  /** Return the database instance. */
  getDb() {
    return this.db
  }

  /** Initializes the database connection and prepares SQL statements for symbol, import, and call operations. */
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
      `INSERT INTO symbol_calls (id, caller_id, callee_name, callee_id, language_name, call_line, call_column, caller_file_path, call_text, docstring) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    this.dbInited = true
    logDebug('Database migrations applied')
  }

  /** Upserts a file by either inserting it if it doesn't exist or updating it if a conflict occurs based on the file path. */
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

  /** Retrieves the hash of a file identified by its path. Returns null if no file is found. */
  async getFileHash(path: string): Promise<string | null> {
    const result = await this.db
      .select({ hash: schema.files.hash })
      .from(schema.files)
      .where(eq(schema.files.path, path))
      .limit(1)

    return result.length > 0 ? result[0]!.hash : null
  }

  /** Deletes a file from the database using its path. */
  async deleteFile(path: string) {
    // Cascades to symbols if ON DELETE CASCADE is set up correctly in schema
    return this.db.delete(schema.files).where(eq(schema.files.path, path))
  }

  /** Inserts or updates symbols in the database based on the provided data. Handles batch operations for efficiency. */
  async upsertSymbols(symbolsData: IndexedSymbol['Insert'][]) {
    if (
      symbolsData.length === 0 ||
      !this.preparedSymbolDelete ||
      !this.preparedSymbolInsert
    ) {
      return
    }

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

  /** Upserts call records into the database by processing an array of call data, resolving callee names to their corresponding symbol IDs, and inserting or updating the records as needed. */
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
          call.call_text,
          call.docstring ?? null,
        )
      }
    })()
  }

  /** Fetches all symbol calls for the specified caller IDs. */
  async getCallsForSymbols(
    callerIds: string[],
  ): Promise<IndexedSymbolCall['Select'][]> {
    if (callerIds.length === 0) return []
    return this.db
      .select()
      .from(schema.symbol_calls)
      .where(inArray(schema.symbol_calls.caller_id, callerIds))
  }

  /** "Retrieves symbols by their unique identifiers, specified by an array of IDs. Returns the details of each symbol." */
  async getSymbolsByIds(ids: string[]): Promise<IndexedSymbol['Select'][]> {
    if (ids.length === 0) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(inArray(schema.symbols.id, ids))
  }

  /** Maintains accurate import records by updating or inserting multiple import entries based on provided data. Ensures no duplicate imports exist per file path. */
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

  /** Searches for symbols matching the given query string, with optional filtering by symbol kind, file pattern, and result limit. */
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

  /** Get a summary of symbols (e.g., functions, variables) defined in a specific file, ordered by their line numbers. */
  async getFileSummary(path: string) {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.file_path, path))
      .orderBy(schema.symbols.line)
  }

  /** "Retrieves the definition of a symbol identified by the given ID." */
  async getDefinition(id: string) {
    const result = await this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.id, id))
      .limit(1)

    return result[0] || null
  }

  /** Retrieves the definition of a symbol by its name and file path. Returns the definition record or null if no matching symbol is found. */
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

  /** Searches for importers whose module paths match the given pattern. */
  async getImporters(moduleNamePattern: string) {
    const pattern = moduleNamePattern.replace(/\*/g, '%')
    logDebug(`Searching for importers with pattern: ${pattern}`)
    return this.db
      .select()
      .from(schema.imports)
      .where(like(schema.imports.module_path, `%${pattern}%`))
  }

  /** Retrieves an import record by its ID. */
  async getImportById(id: string): Promise<IndexedImport['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, id))
      .limit(1)

    return result[0] || null
  }

  /** Retrieves all import records where the imported symbol name matches exactly. */
  async getImportsByName(
    importedName: string,
  ): Promise<IndexedImport['Select'][]> {
    return this.db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.imported_name, importedName))
  }

  /** Retrieves import records that match both the imported symbol name and the file path. */
  async getImportsByNameAndFile(
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

  /** Retrieves all symbols defined within the specified file. */
  async getSymbolsForFile(path: string): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .where(eq(schema.symbols.file_path, path))
      .orderBy(schema.symbols.line)
  }

  /** Retrieves a file from the database based on its path if it exists. */
  async getFileByPath(path: string): Promise<IndexedFile['Select'] | null> {
    const result = await this.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.path, path))
      .limit(1)

    return result[0] || null
  }

  /** Retrieves a file from the database based on a partial file name or path match. */
  async getFileByPartialNameOrPath(
    partialNameOrPath: string,
  ): Promise<IndexedFile['Select'][]> {
    const pattern = `%${partialNameOrPath.replace(/\*/g, '%')}%`
    return this.db
      .select()
      .from(schema.files)
      .where(like(schema.files.path, pattern))
      .orderBy(schema.files.path)
  }

  /** Fetches all files from the database, returning an array containing detailed information for each file, including its path, cryptographic hash, indexing timestamp, and associated language if applicable. */
  async getAllFiles(): Promise<IndexedFile['Select'][]> {
    return this.db.select().from(schema.files)
  }

  /** Returns all symbols in the hierarchy under the specified symbol, including nested children, ordered by their line numbers. */
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

  /** Retrieves all symbols stored in the database. Each symbol contains metadata such as its name, location, and type, which can be used for code analysis or navigation purposes. */
  async getAllSymbols(): Promise<IndexedSymbol['Select'][]> {
    return this.db
      .select()
      .from(schema.symbols)
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  /** Retrieves a list of unresolved calls from the database. */
  async getUnresolvedCalls(): Promise<IndexedSymbolCall['Select'][]> {
    return this.db
      .select()
      .from(schema.symbol_calls)
      .where(
        and(
          isNull(schema.symbol_calls.callee_id),
          isNull(schema.symbol_calls.imports_id),
          isNotNull(schema.symbol_calls.call_line),
        ),
      )
      .orderBy(
        schema.symbol_calls.caller_file_path,
        schema.symbol_calls.call_line,
      )
  }

  /** Updates the callee ID for a specific call. Modifies the associated identifier of the called entity or function in the database record corresponding to the provided call ID. */
  async updateCalleeId(callId: string, calleeId: string): Promise<void> {
    await this.db
      .update(schema.symbol_calls)
      .set({ callee_id: calleeId })
      .where(eq(schema.symbol_calls.id, callId))
  }

  /** Updates the imports ID for a specific call. Modifies the associated identifier of the import record linked to the call in the database based on the provided call ID. */
  async updateImportsId(callId: string, importsId: string): Promise<void> {
    await this.db
      .update(schema.symbol_calls)
      .set({ imports_id: importsId })
      .where(eq(schema.symbol_calls.id, callId))
  }

  /** Retrieves the symbol located at the specified line in the given file path. */
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

  /** Retrieves symbols that require documentation, specifically those whose docstrings are missing or empty for the specified symbol types (kinds). This helps identify parts of the codebase that lack proper documentation. */
  async getSymbolsNeedingDocstrings(
    targetKinds: SymbolKind[],
  ): Promise<IndexedSymbol['Select'][]> {
    if (targetKinds.length === 0) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          inArray(schema.symbols.kind, targetKinds),
          or(
            isNull(schema.symbols.docstring),
            eq(schema.symbols.docstring, ''),
          ),
        ),
      )
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  /** Retrieves symbols that require documentation within a specific file, filtered by target symbol types (kinds). This method helps identify undocumented symbols in a particular file for focused documentation efforts. */
  async getSymbolsNeedingDocstringsForFile(
    relativePath: string,
    targetKinds: SymbolKind[],
  ): Promise<IndexedSymbol['Select'][]> {
    if (targetKinds.length === 0) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.file_path, relativePath),
          inArray(schema.symbols.kind, targetKinds),
          or(
            isNull(schema.symbols.docstring),
            eq(schema.symbols.docstring, ''),
          ),
        ),
      )
      .orderBy(schema.symbols.line)
  }

  /** Retrieves symbols with associated docstrings for specified target kinds. */
  async getSymbolsWithDocstrings(
    targetKinds: SymbolKind[],
  ): Promise<IndexedSymbol['Select'][]> {
    if (targetKinds.length === 0) return []
    return this.db
      .select()
      .from(schema.symbols)
      .where(
        and(
          inArray(schema.symbols.kind, targetKinds),
          and(
            isNotNull(schema.symbols.docstring),
            not(eq(schema.symbols.docstring, '')),
          ),
        ),
      )
      .orderBy(schema.symbols.file_path, schema.symbols.line)
  }

  /** Updates the docstring for the symbol identified by its ID. */
  async updateSymbolDocstring(id: string, docstring: string): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({ docstring })
      .where(eq(schema.symbols.id, id))
  }

  /** "Deletes the docstring of a symbol by its ID." */
  async deleteSymbolDocstring(id: string): Promise<void> {
    await this.db
      .update(schema.symbols)
      .set({ docstring: null })
      .where(eq(schema.symbols.id, id))
  }

  /** Updates the symbol type information in the database for the specified symbol using its ID. */
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

  /** Get information about all callers of a specified symbol, including their file paths, names, and line numbers. */
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

  /** Get all callers of a symbol — direct calls and, if it is a container (class/module/namespace), calls to any of its child symbols.
   *  Returns childName = null for direct callers; the child's name for member callers. */
  async getCallersAll(symbolName: string): Promise<
    Array<{
      callerFile: string
      callerName: string
      line: number
      childName: string | null
    }>
  > {
    return this.sqlite
      .prepare(
        `SELECT DISTINCT s.file_path AS callerFile, s.name AS callerName, s.line, child.name AS childName
         FROM symbol_calls sc
         JOIN symbols t ON t.name = ?
         JOIN symbols s ON s.id = sc.caller_id
         LEFT JOIN symbols child ON child.parent_id = t.id
                                 AND (sc.callee_id = child.id OR sc.callee_name = child.name)
         WHERE (sc.callee_id = t.id OR sc.callee_name = t.name)
            OR child.id IS NOT NULL
         ORDER BY s.file_path, s.line`,
      )
      .all(symbolName) as any[]
  }

  /** Clears all stored data. */
  async clear() {
    await this.db.delete(schema.symbols)
    await this.db.delete(schema.imports)
    await this.db.delete(schema.files)
    await this.db.delete(schema.symbol_calls)
  }
}
