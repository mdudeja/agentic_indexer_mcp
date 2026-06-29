import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { IndexPipeline } from '../src/indexer/IndexPipeline'
import { IndexerDB } from '../src/database/IndexerDB'
import { AppStateManager } from '../src/state'
import { loadConfig } from '../src/config/loader'
import * as path from 'path'
import * as schema from '../src/database/schemas'

describe('IndexPipeline Integration Tests', () => {
  let store: IndexerDB
  let pipeline: IndexPipeline
  const fixturePath = path.join(import.meta.dir, 'fixtures/test-project')

  beforeAll(async () => {
    // 1. Setup AppState config
    const config = await loadConfig(fixturePath)
    AppStateManager.getInstance().setItem('config', config)
    AppStateManager.getInstance().setItem('root', fixturePath)

    // 2. Initialize In-Memory DB
    store = IndexerDB.getInstance(':memory:')
    await store.init()

    // 3. Create Pipeline
    pipeline = new IndexPipeline({
      cwd: fixturePath,
      store,
      includeGitIgnored: true,
    })
  })

  afterAll(async () => {
    await store.clear()
    store.close()
  })

  it('should execute the indexing pipeline and populate the database', async () => {
    // Run the pipeline
    await pipeline.run()

    const db = store.getDb()

    // Check files table
    const dbFiles = await db.select().from(schema.files)
    expect(dbFiles.length).toBeGreaterThanOrEqual(3)

    const filePaths = dbFiles.map((f) => f.path)
    expect(filePaths).toContain('math.ts')
    expect(filePaths).toContain('app.ts')
    expect(filePaths).toContain('auth.py')

    // Check symbols table
    const dbSymbols = await db.select().from(schema.symbols)
    expect(dbSymbols.length).toBeGreaterThanOrEqual(6)

    const symbolNames = dbSymbols.map((s) => s.name)
    expect(symbolNames).toContain('add')
    expect(symbolNames).toContain('subtract')
    expect(symbolNames).toContain('Calculator')
    expect(symbolNames).toContain('multiply')
    expect(symbolNames).toContain('Authenticator')
    expect(symbolNames).toContain('authenticate')

    // Check imports table
    const dbImports = await db.select().from(schema.imports)
    expect(dbImports.length).toBeGreaterThanOrEqual(2)
    const appImports = dbImports.filter((i) => i.file_path === 'app.ts')
    expect(appImports.length).toBeGreaterThanOrEqual(2)
    expect(appImports.map((i) => i.imported_name)).toContain('add')
    expect(appImports.map((i) => i.imported_name)).toContain('Calculator')

    // Check calls table
    const dbCalls = await db.select().from(schema.symbol_calls)
    expect(dbCalls.length).toBeGreaterThanOrEqual(2)
    const multiplyCalls = dbCalls.filter((c) => c.callee_name === 'multiply')
    expect(multiplyCalls.length).toBeGreaterThanOrEqual(1)

    // Check exceptions table
    const dbExceptions = await db.select().from(schema.exceptions)
    expect(dbExceptions.length).toBeGreaterThanOrEqual(2)
    expect(dbExceptions.map((e) => e.exception_type)).toContain('Error')

    // Check env vars table
    const dbEnvVars = await db.select().from(schema.env_vars)
    expect(dbEnvVars.length).toBeGreaterThanOrEqual(2)
    const envNames = dbEnvVars.map((e) => e.name)
    expect(envNames).toContain('APP_TOKEN')
    expect(envNames.some((name) => name.includes('AUTH_SECRET'))).toBe(true)
  }, 10000) // Increase timeout to 10s as it sleeps for 3s during execution
})
