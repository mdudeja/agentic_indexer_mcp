import { describe, it, expect, beforeAll } from 'bun:test'
import { TreeSitterIndexer } from '../src/indexer/TreeSitterIndexer'
import * as path from 'path'
import * as fs from 'fs'
import { SymbolKind } from 'src/database/schemas'
describe('TreeSitterIndexer Unit Tests', () => {
  let indexer: TreeSitterIndexer
  const fixturePath = path.resolve(process.env.IDXR_TEST_FIXTURES_DIR as string)

  beforeAll(async () => {
    indexer = new TreeSitterIndexer()
    await indexer.init()
  })

  it('should parse TS file math.ts and extract functions, classes, interface, enum, type, namespace', async () => {
    const mathTsPath = `${fixturePath}/math.ts`
    const content = fs.readFileSync(mathTsPath, 'utf-8')

    const result = await indexer.parse(content, 'ts', 'math.ts')

    expect(result).toBeDefined()

    const addSymbol = result.symbols.find((s) => s.name === 'add')
    expect(addSymbol).toBeDefined()
    expect(addSymbol?.kind).toBe(SymbolKind.function)
    expect(addSymbol?.exported).toBe(true)

    const calcSymbol = result.symbols.find((s) => s.name === 'Calculator')
    expect(calcSymbol).toBeDefined()
    expect(calcSymbol?.kind).toBe(SymbolKind.class)

    const multiplySymbol = result.symbols.find((s) => s.name === 'multiply')
    expect(multiplySymbol).toBeDefined()
    expect(multiplySymbol?.kind).toBe(SymbolKind.method)

    // interface
    const shape = result.symbols.find((s) => s.name === 'Shape')
    expect(shape?.kind).toBe(SymbolKind.interface)

    // type alias
    const vector = result.symbols.find((s) => s.name === 'Vector')
    expect(vector?.kind).toBe(SymbolKind.type)

    // enum
    const direction = result.symbols.find((s) => s.name === 'Direction')
    expect(direction?.kind).toBe(SymbolKind.enum)

    // namespace
    const ns = result.symbols.find((s) => s.name === 'MathUtils')
    expect(ns?.kind).toBe(SymbolKind.namespace)

    // const arrow function
    const doubleFn = result.symbols.find((s) => s.name === 'double')
    expect(doubleFn?.kind).toBe(SymbolKind.arrowFunction)

    // let / var
    const counterSym = result.symbols.find((s) => s.name === 'counter')
    expect(counterSym?.kind).toBe(SymbolKind.let)

    const legacySym = result.symbols.find((s) => s.name === 'legacyFlag')
    expect(legacySym?.kind).toBe(SymbolKind.var)

    // class field
    const labelField = result.symbols.find((s) => s.name === 'label')
    expect(labelField?.kind).toBe(SymbolKind.property)

    // constructor parameter properties
    const xProp = result.symbols.find(
      (s) => s.name === 'x' && s.kind === SymbolKind.property,
    )
    expect(xProp).toBeDefined()

    // trailing inline docstring on PI const
    const piSym = result.symbols.find((s) => s.name === 'PI')
    expect(piSym).toBeDefined()
    expect(piSym?.docstring).toBeTruthy()

    // explicit re-export of non-exported function
    expect(
      result.explicitExports.some((e) => e.name === 'internalHelper'),
    ).toBe(true)

    // empty named import { } creates a record with empty imported_name
    const emptyImport = result.imports.find(
      (i) => i.importedNames?.length === 0,
    )
    expect(emptyImport).toBeDefined()

    // namespace import (import * as fs) creates a record
    const fsImport = result.imports.find((i) => i.importedNames?.includes('fs'))
    expect(fsImport).toBeDefined()
  })

  it('should parse TS file app.ts and extract imports, calls, exceptions, env vars, decorators', async () => {
    const appTsPath = `${fixturePath}/app.ts`
    const content = fs.readFileSync(appTsPath, 'utf-8')

    const result = await indexer.parse(content, 'ts', 'app.ts')

    expect(result).toBeDefined()

    // named imports
    const importAdd = result.imports.find((i) =>
      i.importedNames?.includes('add'),
    )
    expect(importAdd).toBeDefined()

    // calls
    expect(result.call_sites?.length).toBeGreaterThanOrEqual(2)
    const multiplyCall = result.call_sites?.find(
      (c) => c.callee_name === 'multiply',
    )
    expect(multiplyCall).toBeDefined()

    // env vars
    const tokenEnv = result.envVars.find((e) => e.name === 'APP_TOKEN')
    expect(tokenEnv).toBeDefined()

    // subscript env var (process.env['SERVICE_KEY'])
    const serviceKey = result.envVars.find((e) =>
      e.name.includes('SERVICE_KEY'),
    )
    expect(serviceKey).toBeDefined()

    // exceptions
    const typeErr = result.exceptions.find((e) => e.exception_type === 'Error')
    expect(typeErr).toBeDefined()

    // decorated class
    const service = result.symbols.find((s) => s.name === 'Service')
    expect(service?.decorator).toBeTruthy()

    // decorated method
    const runMethod = result.symbols.find((s) => s.name === 'run')
    expect(runMethod?.decorator).toBeTruthy()
  })

  it('should parse Python file auth.py and extract __all__, aliased imports, class attrs, single-quote docstrings', async () => {
    const authPyPath = `${fixturePath}/auth.py`
    const content = fs.readFileSync(authPyPath, 'utf-8')

    const result = await indexer.parse(content, 'py', 'auth.py')

    expect(result).toBeDefined()

    // __all__ exports
    expect(result.explicitExports.some((e) => e.name === 'Authenticator')).toBe(
      true,
    )
    expect(
      result.explicitExports.some((e) => e.name === 'login_required'),
    ).toBe(true)

    // aliased import (import os as operating_system)
    const aliasedImport = result.imports.find((i) =>
      i.importedNames?.includes('os as operating_system'),
    )
    expect(aliasedImport).toBeDefined()

    // module-level variable
    const maxAttempts = result.symbols.find((s) => s.name === 'MAX_ATTEMPTS')
    expect(maxAttempts).toBeDefined()

    // class field via self.attempts
    const attemptsField = result.symbols.find((s) => s.name === 'attempts')
    expect(attemptsField?.kind).toBe(SymbolKind.property)

    // class-level attribute
    const secretKey = result.symbols.find((s) => s.name === 'secret_key')
    expect(secretKey).toBeDefined()

    // single-quote docstring on login_required
    const loginFn = result.symbols.find((s) => s.name === 'login_required')
    expect(loginFn?.docstring).toBeTruthy()

    // class and methods
    const authClass = result.symbols.find((s) => s.name === 'Authenticator')
    expect(authClass?.kind).toBe(SymbolKind.class)

    const authMethod = result.symbols.find((s) => s.name === 'authenticate')
    expect(authMethod?.kind).toBe(SymbolKind.method)
    expect(authMethod?.decorator).toContain('@login_required')

    // env vars
    const secretEnv = result.envVars.find((e) => e.name.includes('AUTH_SECRET'))
    expect(secretEnv).toBeDefined()
  })

  it('should parse Python file app.py and extract relative from-imports with aliases', async () => {
    const appPyPath = `${fixturePath}/app.py`
    const content = fs.readFileSync(appPyPath, 'utf-8')

    const result = await indexer.parse(content, 'py', 'app.py')

    expect(result).toBeDefined()

    // from .auth import Authenticator
    const authImport = result.imports.find((i) =>
      i.importedNames?.includes('Authenticator'),
    )
    expect(authImport).toBeDefined()

    // from .auth import login_required as require_login
    const aliasImport = result.imports.find((i) =>
      i.importedNames?.includes('login_required as require_login'),
    )
    expect(aliasImport).toBeDefined()
  })

  it('should extract decorators and docstrings for a decorated class nested inside an arrow-function argument (e.g. inside test()/describe())', async () => {
    // When a class is declared inside an arrow function argument (the common
    // pattern in test files), tree-sitter nests the leading `decorator` and
    // the class docstring `comment` as *children* of the class_declaration,
    // rather than as siblings. This must still be captured.
    const source = `
describe('ImplementsStatic', () => {
  test('returns the same class reference unchanged (pure passthrough)', () => {
    @ImplementsStatic<FactoryStatics>()
    /** A class designed to create and manage greeting messages. */
    class Greeter {
      /** Returns a friendly greeting. */
      greet() {
        return 'hi'
      }
    }
  })
})`

    const result = await indexer.parse(source, 'ts', 'nested-test.ts')

    expect(result).toBeDefined()

    const greeter = result.symbols.find((s) => s.name === 'Greeter')
    expect(greeter).toBeDefined()
    expect(greeter?.kind).toBe(SymbolKind.class)

    // The class-level docstring (a child of class_declaration in this nesting)
    expect(greeter?.docstring).toBeTruthy()
    expect(greeter?.docstring).toContain(
      'A class designed to create and manage greeting messages',
    )

    // The decorator must be attached to the class even when nested
    expect(greeter?.decorator).toBeTruthy()
    expect(greeter?.decorator).toContain('@ImplementsStatic<FactoryStatics>()')

    // The method still gets its own docstring and is parented to the class
    const greet = result.symbols.find((s) => s.name === 'greet')
    expect(greet).toBeDefined()
    expect(greet?.kind).toBe(SymbolKind.method)
    expect(greet?.docstring).toBeTruthy()
    expect(greet?.parent_id).toBe(greeter?.id)
  })
})
