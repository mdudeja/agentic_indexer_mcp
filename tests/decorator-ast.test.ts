import { describe, it, expect, beforeAll } from 'bun:test'
import { readFileSync } from 'fs'
import path from 'path'
import { Parser, Language, Query } from 'web-tree-sitter'
import { extractSymbols } from '../src/indexer/steps/s1_symbol_extractor'

let pyLang: Language
let tsLang: Language
let pyQuery: Query
let tsQuery: Query
let parser: Parser

beforeAll(async () => {
  await Parser.init()
  parser = new Parser()

  pyLang = await Language.load(
    require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'),
  )
  tsLang = await Language.load(
    require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'),
  )

  const root = path.join(import.meta.dir, '..')
  pyQuery = new Query(
    pyLang,
    readFileSync(path.join(root, 'src/indexer/queries/python/tags.scm'), 'utf-8'),
  )
  tsQuery = new Query(
    tsLang,
    readFileSync(
      path.join(root, 'src/indexer/queries/typescript/tags.scm'),
      'utf-8',
    ),
  )
})

const parsePy = (src: string) => {
  parser.setLanguage(pyLang)
  return parser.parse(src)!
}

const parseTs = (src: string) => {
  parser.setLanguage(tsLang)
  return parser.parse(src)!
}

describe('Python decorator extraction', () => {
  it('attaches a single decorator to a function', () => {
    const tree = parsePy(`
@property
def my_func(self):
    pass
`)
    const result = extractSymbols(tree.rootNode, 'test.py', 'python', pyQuery)
    const fn = result.symbols.find((s) => s.name === 'my_func')
    expect(fn?.decorator).toBe('@property')
  })

  it('attaches a single decorator to a class', () => {
    const tree = parsePy(`
@dataclass
class MyClass:
    pass
`)
    const result = extractSymbols(tree.rootNode, 'test.py', 'python', pyQuery)
    const cls = result.symbols.find((s) => s.name === 'MyClass')
    expect(cls?.decorator).toBe('@dataclass')
  })

  it('accumulates multiple decorators on a function', () => {
    const tree = parsePy(`
@property
@app.route('/path')
def my_func(self):
    pass
`)
    const result = extractSymbols(tree.rootNode, 'test.py', 'python', pyQuery)
    const fn = result.symbols.find((s) => s.name === 'my_func')
    expect(fn?.decorator).toBe("@property\n@app.route('/path')")
  })

  it('does not set decorator on undecorated symbols', () => {
    const tree = parsePy(`
def plain():
    pass
`)
    const result = extractSymbols(tree.rootNode, 'test.py', 'python', pyQuery)
    const fn = result.symbols.find((s) => s.name === 'plain')
    expect(fn?.decorator).toBeNull()
  })
})

describe('TypeScript decorator extraction', () => {
  it('attaches a decorator to an exported class', () => {
    const tree = parseTs(`
@Injectable()
export class MyService {}
`)
    const result = extractSymbols(tree.rootNode, 'test.ts', 'typescript', tsQuery)
    const cls = result.symbols.find((s) => s.name === 'MyService')
    expect(cls?.decorator).toBe('@Injectable()')
  })

  it('attaches a decorator to a method', () => {
    const tree = parseTs(`
class Foo {
  @HostListener('click')
  onClick() {}
}
`)
    const result = extractSymbols(tree.rootNode, 'test.ts', 'typescript', tsQuery)
    const method = result.symbols.find((s) => s.name === 'onClick')
    expect(method?.decorator).toBe("@HostListener('click')")
  })

  it('attaches a decorator to a field', () => {
    const tree = parseTs(`
class Foo {
  @Input() name: string = '';
}
`)
    const result = extractSymbols(tree.rootNode, 'test.ts', 'typescript', tsQuery)
    const field = result.symbols.find((s) => s.name === 'name')
    expect(field?.decorator).toBe('@Input()')
  })

  it('captures all stacked decorators on a class', () => {
    const tree = parseTs(`
@Injectable()
@Component({ selector: 'app' })
export class AppComponent {}
`)
    const result = extractSymbols(
      tree.rootNode,
      'test.ts',
      'typescript',
      tsQuery,
    )
    const cls = result.symbols.find((s) => s.name === 'AppComponent')
    expect(cls?.decorator).toBe("@Injectable()\n@Component({ selector: 'app' })")
  })

  it('does not set decorator on undecorated symbols', () => {
    const tree = parseTs(`
class Plain {}
`)
    const result = extractSymbols(tree.rootNode, 'test.ts', 'typescript', tsQuery)
    const cls = result.symbols.find((s) => s.name === 'Plain')
    expect(cls?.decorator).toBeNull()
  })
})
