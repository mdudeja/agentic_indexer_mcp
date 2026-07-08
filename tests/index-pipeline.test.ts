import { describe, expect, beforeAll, test } from 'bun:test'
import { IndexerDB } from '../src/database/IndexerDB'
import * as schema from '../src/database/schemas'
import { getStoreForTests } from '../scripts/test_setup'

describe('IndexPipeline Integration Tests', () => {
  let store: IndexerDB

  beforeAll(async () => {
    store = getStoreForTests()
  })

  test('should populate the database correctly', async () => {
    const db = store.getDb()

    // Check files table
    const dbFiles = await db.select().from(schema.files)
    expect(dbFiles.length).toBeGreaterThanOrEqual(4)

    const filePaths = dbFiles.map((f) => f.path)
    expect(filePaths).toContain('math.ts')
    expect(filePaths).toContain('app.ts')
    expect(filePaths).toContain('app.py')
    expect(filePaths).toContain('auth.py')

    // Check symbols table
    const dbSymbols = await db.select().from(schema.symbols)
    expect(dbSymbols.length).toBeGreaterThanOrEqual(6)

    const symbolNames = dbSymbols.map((s) => s.name)
    expect(symbolNames).toContain('add')
    expect(symbolNames).toContain('subtract')
    expect(symbolNames).toContain('Calculator')
    expect(symbolNames).toContain('runCalculation')
    expect(symbolNames).toContain('multiply')
    expect(symbolNames).toContain('Authenticator')
    expect(symbolNames).toContain('authenticate')
    expect(symbolNames).toContain('login_required')

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
  })
})
