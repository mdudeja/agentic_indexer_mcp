import { Database } from 'bun:sqlite'
import { drizzle, type SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import * as schema from './schemas'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { resolvePath } from 'src/utils/paths'
import { logDebug, logError } from 'src/utils/logger'
import * as sqliteVec from 'sqlite-vec'
import {
  EmbeddingRepository,
  SymbolRepository,
  FileRepository,
  ImportRepository,
  CallRepository,
  AnalysisRepository,
  ToolUsageRepository,
} from './repositories'
import { CallSitesRepository } from './repositories/CallSitesRepository'
import { CallEdgesRepository } from './repositories/CallEdgesRepository'

/** A singleton class managing SQLite database connections with vector indexing capabilities. It provides repository interfaces for handling embeddings, symbols, files, imports, calls, analysis, and tool usage. The IndexerDB initializes the database connection, runs migrations, and ensures proper resource management. */
export class IndexerDB {
  private dbInited: boolean = false
  private dbFilePath?: string
  private static instance: IndexerDB | null = null
  private isMemory: boolean = false
  private sqlite: Database
  private db: SQLiteBunDatabase<typeof schema>

  readonly embeddings: EmbeddingRepository
  readonly symbols: SymbolRepository
  readonly files: FileRepository
  readonly imports: ImportRepository
  readonly calls: CallRepository
  readonly callSites: CallSitesRepository
  readonly callEdges: CallEdgesRepository
  readonly analysis: AnalysisRepository
  readonly toolUsage: ToolUsageRepository

  /** Initializes the database connection and constructs the application's data repositories. */
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

    try {
      sqliteVec.load(this.sqlite)
      logDebug('sqlite-vec extension loaded successfully')
    } catch (err) {
      logError('Failed to load sqlite-vec extension:', err)
    }

    this.sqlite.run('PRAGMA foreign_keys = ON;')
    this.sqlite.run('PRAGMA journal_mode = WAL;')
    this.sqlite.run('PRAGMA synchronous = NORMAL;')

    this.db = drizzle({ client: this.sqlite, schema })

    this.embeddings = new EmbeddingRepository(this.sqlite)
    this.symbols = new SymbolRepository(this.sqlite, this.db, this.embeddings)
    this.files = new FileRepository(this.db, this.embeddings)
    this.imports = new ImportRepository(this.sqlite, this.db)
    this.calls = new CallRepository(this.sqlite, this.db)
    this.callSites = new CallSitesRepository(this.sqlite)
    this.callEdges = new CallEdgesRepository(this.sqlite)
    this.analysis = new AnalysisRepository(
      this.sqlite,
      this.symbols,
      this.calls,
    )
    this.toolUsage = new ToolUsageRepository(this.sqlite)
  }

  /** Returns the singleton instance of IndexerDB, ensuring only one instance exists per database path. */
  static getInstance(dbPath?: string): IndexerDB {
    if (
      !IndexerDB.instance ||
      (dbPath !== undefined && IndexerDB.instance.dbFilePath !== dbPath)
    ) {
      IndexerDB.instance = new IndexerDB(dbPath)
    }
    return IndexerDB.instance
  }

  /** Gets the database object. */
  getDb() {
    return this.db
  }

  /** Initialize the database and related components when the application starts. This includes running migrations, creating necessary database tables, and preparing statements for various modules. */
  async init() {
    if (this.dbInited) return

    const migrationsDir = resolvePath(
      process.env.DB_MIGRATIONS_DIR || './drizzle_migrations',
      resolvePath('../../', import.meta.dir),
    )
    migrate(this.db, { migrationsFolder: migrationsDir })

    try {
      this.sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_symbols USING vec0(
          symbol_id TEXT PRIMARY KEY,
          embedding float[768]
        );
      `)
      logDebug('sqlite-vec virtual table initialized')
    } catch (err) {
      logError('Failed to create sqlite-vec virtual table:', err)
    }

    this.embeddings.initStatements()
    this.symbols.initStatements()
    this.imports.initStatements()
    this.calls.initStatements()
    this.callSites.initStatements()
    this.callEdges.initStatements()
    this.analysis.initStatements()
    this.toolUsage.initStatements()

    this.dbInited = true
    logDebug('Database initialized')
  }

  /** Deletes all data from the database tables. */
  async clear() {
    try {
      this.sqlite.run(`DELETE FROM vec_symbols`)
    } catch (err) {
      logError('Failed to clear vec_symbols:', err)
    }
    await this.db.delete(schema.symbols)
    await this.db.delete(schema.imports)
    await this.db.delete(schema.files)
    await this.db.delete(schema.symbol_calls)
    await this.db.delete(schema.tool_usage)
    await this.db.delete(schema.exceptions)
    await this.db.delete(schema.env_vars)
    await this.db.delete(schema.call_sites)
    await this.db.delete(schema.call_edges)
  }

  /** Closes the SQLite database connection, cleans up associated resources, and resets internal state. */
  close() {
    this.sqlite.run('PRAGMA journal_mode = DELETE;')
    this.sqlite.close()
    this.dbInited = false
    IndexerDB.instance = null
    logDebug('Database connection closed')
  }
}
