import { describe, it, expect, beforeAll } from 'bun:test'
import { TreeSitterIndexer } from '../src/indexer/TreeSitterIndexer'
import * as path from 'path'
import * as fs from 'fs'
import { SymbolKind } from 'src/database/schemas'
describe('TreeSitterIndexer Unit Tests', () => {
  let indexer: TreeSitterIndexer
  const fixturePath = path.resolve(process.env.TEST_FIXTURES_DIR as string)

  beforeAll(async () => {
    indexer = new TreeSitterIndexer()
    await indexer.init()
  })

  it('should parse TS file math.ts and extract functions and classes', async () => {
    const mathTsPath = `${fixturePath}/math.ts`
    const content = fs.readFileSync(mathTsPath, 'utf-8')

    const result = await indexer.parse(content, 'ts', 'math.ts')

    expect(result).toBeDefined()
    expect(result.symbols.length).toBeGreaterThanOrEqual(3)

    const addSymbol = result.symbols.find((s) => s.name === 'add')
    expect(addSymbol).toBeDefined()
    expect(addSymbol?.kind).toBe(SymbolKind.function)
    expect(addSymbol?.exported).toBe(true)

    const calcSymbol = result.symbols.find((s) => s.name === 'Calculator')
    expect(calcSymbol).toBeDefined()
    expect(calcSymbol?.kind).toBe(SymbolKind.class)
    expect(calcSymbol?.exported).toBe(true)

    const multiplySymbol = result.symbols.find((s) => s.name === 'multiply')
    expect(multiplySymbol).toBeDefined()
    expect(multiplySymbol?.kind).toBe(SymbolKind.method)
    expect(multiplySymbol?.exported).toBe(false)
  })

  it('should parse TS file app.ts and extract imports, calls, exceptions, and env vars', async () => {
    const appTsPath = `${fixturePath}/app.ts`
    const content = fs.readFileSync(appTsPath, 'utf-8')

    const result = await indexer.parse(content, 'ts', 'app.ts')

    expect(result).toBeDefined()

    // Verify imports
    expect(result.imports.length).toBeGreaterThanOrEqual(2)
    const importAdd = result.imports.find((i) => i.imported_name === 'add')
    expect(importAdd).toBeDefined()
    expect(importAdd?.module_path).toBe('math.ts')

    // Verify calls
    expect(result.calls.length).toBeGreaterThanOrEqual(2)
    const multiplyCall = result.calls.find((c) => c.callee_name === 'multiply')
    expect(multiplyCall).toBeDefined()

    // Verify environment variables
    expect(result.envVars.length).toBeGreaterThanOrEqual(1)
    const tokenEnv = result.envVars.find((e) => e.name === 'APP_TOKEN')
    expect(tokenEnv).toBeDefined()

    // Verify exceptions
    expect(result.exceptions.length).toBeGreaterThanOrEqual(1)
    const typeErr = result.exceptions.find((e) => e.exception_type === 'Error')
    expect(typeErr).toBeDefined()
  })

  it('should parse Python file auth.py and extract decorators, classes, exceptions, and env vars', async () => {
    const authPyPath = `${fixturePath}/auth.py`
    const content = fs.readFileSync(authPyPath, 'utf-8')

    const result = await indexer.parse(content, 'py', 'auth.py')

    expect(result).toBeDefined()

    // Verify class and methods
    const authClass = result.symbols.find((s) => s.name === 'Authenticator')
    expect(authClass).toBeDefined()
    expect(authClass?.kind).toBe(SymbolKind.class)

    const authMethod = result.symbols.find((s) => s.name === 'authenticate')
    expect(authMethod).toBeDefined()
    expect(authMethod?.kind).toBe(SymbolKind.method)
    expect(authMethod?.decorator).toContain('@login_required')

    // Verify env vars
    const secretEnv = result.envVars.find((e) => e.name.includes('AUTH_SECRET'))
    expect(secretEnv).toBeDefined()

    // Verify exceptions
    const valError = result.exceptions.find((e) => e.exception_type === 'Error')
    expect(valError).toBeDefined()
  })
})
