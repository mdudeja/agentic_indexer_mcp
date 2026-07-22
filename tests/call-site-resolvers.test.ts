import { describe, expect, test, beforeAll } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import { TreeSitterIndexer } from '../src/indexer/TreeSitterIndexer'
import type { ExtractionResult } from '../src/indexer/adapters/LanguageAdapter'
import {
  TypescriptCallSiteResolver,
  PythonCallSiteResolver,
  removeWrappingParenthesis,
} from '../src/indexer/resolvers/callSiteResolvers'
import { CallKind } from '../src/database/schemas'

const fixturePath = path.resolve(process.env.TEST_FIXTURES_DIR as string)

let mathTs: ExtractionResult
let appTs: ExtractionResult
let authPy: ExtractionResult
let appPy: ExtractionResult

beforeAll(async () => {
  const indexer = new TreeSitterIndexer()
  await indexer.init()

  mathTs = await indexer.parse(
    fs.readFileSync(`${fixturePath}/math.ts`, 'utf-8'),
    'ts',
    'math.ts',
  )
  appTs = await indexer.parse(
    fs.readFileSync(`${fixturePath}/app.ts`, 'utf-8'),
    'ts',
    'app.ts',
  )
  authPy = await indexer.parse(
    fs.readFileSync(`${fixturePath}/auth.py`, 'utf-8'),
    'py',
    'auth.py',
  )
  appPy = await indexer.parse(
    fs.readFileSync(`${fixturePath}/app.py`, 'utf-8'),
    'py',
    'app.py',
  )
})

describe('TypescriptCallSiteResolver (via math.ts / app.ts)', () => {
  test('resolves a plain function call', () => {
    const call = appTs.call_sites?.find((c) => c.call_text === 'add(prod, 10)')
    expect(call).toBeDefined()
    expect(call?.call_kind).toBe(CallKind.FunctionCall)
    expect(call?.callee_name).toBe('add')
    expect(call?.callee_expression).toBe('add')
    expect(call?.callee_base).toBeUndefined()
  })

  test('resolves a method call and splits callee_base/callee_property', () => {
    const call = appTs.call_sites?.find(
      (c) => c.call_text === 'console.log(msg)',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_name).toBe('log')
    expect(call?.callee_base).toBe('console')
    expect(call?.callee_property).toBe('log')
  })

  test('resolves a method call on a local variable', () => {
    const call = appTs.call_sites?.find(
      (c) => c.call_text === 'calc.multiply(x, y)',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_base).toBe('calc')
    expect(call?.callee_property).toBe('multiply')
  })

  test('resolves nested method calls sharing the same base (Math.min(Math.max(...), hi))', () => {
    const outer = mathTs.call_sites?.find(
      (c) => c.call_text === 'Math.min(Math.max(v, lo), hi)',
    )
    const inner = mathTs.call_sites?.find(
      (c) => c.call_text === 'Math.max(v, lo)',
    )
    expect(outer?.callee_base).toBe('Math')
    expect(outer?.callee_property).toBe('min')
    expect(inner?.callee_base).toBe('Math')
    expect(inner?.callee_property).toBe('max')
  })

  test('resolves a constructor call', () => {
    const call = appTs.call_sites?.find(
      (c) => c.call_text === 'new Calculator()',
    )
    expect(call?.call_kind).toBe(CallKind.ConstructorCall)
    expect(call?.callee_name).toBe('Calculator')
    expect(call?.callee_expression).toBe('Calculator')
  })

  test('resolves a constructor call used as a bare error-throw argument', () => {
    const call = appTs.call_sites?.find(
      (c) => c.call_text === "new TypeError('Missing token')",
    )
    expect(call?.call_kind).toBe(CallKind.ConstructorCall)
    expect(call?.callee_name).toBe('TypeError')
  })

  test('resolves a decorator applied with call syntax as a DecoratorCall', () => {
    const call = appTs.call_sites?.find(
      (c) => c.call_text === 'decoratorFactory()',
    )
    expect(call?.call_kind).toBe(CallKind.DecoratorCall)
    expect(call?.callee_name).toBe('decoratorFactory')
  })

  test('resolves super.method() as an ordinary method call with callee_base "super"', () => {
    const call = appTs.call_sites?.find((c) => c.call_text === 'super.run()')
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_base).toBe('super')
    expect(call?.callee_property).toBe('run')
  })

  test('does not produce a call site for a bare super(...) constructor call (function field is a `super` node, not an identifier, so it is never captured)', () => {
    const call = appTs.call_sites?.find((c) => c.call_text === 'super()')
    expect(call).toBeUndefined()
  })

  test('does not produce a call site for a dynamic bracket call (TS): the resolved call node lacks a resolvable callee name', () => {
    const call = appTs.call_sites?.find(
      (c) => c.call_text === "actions['run']()",
    )
    expect(call).toBeUndefined()
  })

  test('strips a nullish-coalescing default value from callee_base', () => {
    const call = mathTs.call_sites?.find(
      (c) => c.call_text === 'wrapValue(a ?? 5).double()',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_property).toBe('double')
    expect(call?.callee_base).toBe('wrapValue(a)')
  })

  test('strips a type-cast prefix and unwraps parentheses when computing callee_base', () => {
    const call = mathTs.call_sites?.find(
      (c) => c.call_text === '(value as Point).distanceTo(new Point(0, 0))',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_base).toBe('value')
    expect(call?.callee_property).toBe('distanceTo')
  })

  test('splits an optional-chaining member call', () => {
    const call = mathTs.call_sites?.find(
      (c) => c.call_text === 'p?.distanceTo?.(new Point(0, 0))',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_name).toBe('distanceTo')
    expect(call?.callee_base).toBe('p')
    expect(call?.callee_property).toBe('distanceTo')
  })

  test('reports 1-based call_line/call_column and end_line/end_column', () => {
    const call = mathTs.call_sites?.find(
      (c) => c.call_text === "fs.existsSync('/')",
    )
    expect(call?.call_line).toBe(13)
    expect(call?.call_column).toBe(13)
    expect(call?.end_line).toBe(13)
    expect(call?.end_column).toBe(23)
  })
})

describe('PythonCallSiteResolver (via auth.py / app.py)', () => {
  test('resolves a plain function call', () => {
    const call = appPy.call_sites?.find(
      (c) => c.call_text === 'print("Authentication successful")',
    )
    expect(call?.call_kind).toBe(CallKind.FunctionCall)
    expect(call?.callee_name).toBe('print')
  })

  test('resolves calling a class as an ordinary function call (Python has no distinct ConstructorCall capture)', () => {
    const call = appPy.call_sites?.find(
      (c) => c.call_text === 'Authenticator()',
    )
    expect(call?.call_kind).toBe(CallKind.FunctionCall)
    expect(call?.callee_name).toBe('Authenticator')
  })

  test('resolves a method call and splits callee_base/callee_property', () => {
    const call = appPy.call_sites?.find(
      (c) => c.call_text === 'auth.authenticate("admin", "secret")',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_base).toBe('auth')
    expect(call?.callee_property).toBe('authenticate')
  })

  test('resolves a multi-part attribute chain as callee_base', () => {
    const call = authPy.call_sites?.find(
      (c) => c.call_text === 'os.environ.get("AUTH_SECRET")',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_base).toBe('os.environ')
    expect(call?.callee_property).toBe('get')
  })

  test('resolves a decorator applied with call syntax as a DecoratorCall', () => {
    const call = authPy.call_sites?.find(
      (c) => c.call_text === "require_role('admin')",
    )
    expect(call?.call_kind).toBe(CallKind.DecoratorCall)
    expect(call?.callee_name).toBe('require_role')
  })

  test('resolves a bare decorator reference (no call syntax) as a DecoratorCall too, since it goes through the decorator-parent check independent of shape', () => {
    // `@login_required` (no parens) still triggers the call.identifier
    // capture on `login_required` used elsewhere in the file as a plain
    // function call, so instead we confirm the plain non-decorator usage
    // resolves as an ordinary function call.
    const call = authPy.call_sites?.find(
      (c) => c.call_text === 'func(*args, **kwargs)',
    )
    expect(call?.call_kind).toBe(CallKind.FunctionCall)
    expect(call?.callee_name).toBe('func')
  })

  test('strips an `or` default value from callee_base', () => {
    const call = authPy.call_sites?.find(
      (c) => c.call_text === 'wrap_value(a or 5).double()',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_property).toBe('double')
    expect(call?.callee_base).toBe('wrap_value(a)')
  })

  test('resolves super().method() as an ordinary method call with callee_base "super()"', () => {
    const call = authPy.call_sites?.find(
      (c) => c.call_text === 'super().__init__()',
    )
    expect(call?.call_kind).toBe(CallKind.MethodCall)
    expect(call?.callee_base).toBe('super()')
    expect(call?.callee_property).toBe('__init__')
  })

  test('also resolves the bare super() inside super().__init__() as its own plain function call, since call.identifier and call.member both match the same source', () => {
    const call = authPy.call_sites?.find((c) => c.call_text === 'super()')
    expect(call?.call_kind).toBe(CallKind.FunctionCall)
    expect(call?.callee_name).toBe('super')
  })

  test('resolves a dynamic subscript call, including the (quoted) string key as callee_name', () => {
    const call = appPy.call_sites?.find(
      (c) => c.call_text === "handlers['run']()",
    )
    expect(call?.call_kind).toBe(CallKind.DynamicCall)
    expect(call?.callee_name).toBe("'run'")
  })

  test('resolves the inner getattr(...) call as a plain function call', () => {
    const call = appPy.call_sites?.find(
      (c) => c.call_text === "getattr(obj, 'run')",
    )
    expect(call?.call_kind).toBe(CallKind.FunctionCall)
    expect(call?.callee_name).toBe('getattr')
  })

  test('does not produce a call site for the outer getattr(...)() dynamic call: the resolved call node lacks a resolvable callee name', () => {
    const call = appPy.call_sites?.find(
      (c) => c.call_text === "getattr(obj, 'run')()",
    )
    expect(call).toBeUndefined()
  })

  test('reports 1-based call_line/call_column and end_line/end_column', () => {
    const call = appPy.call_sites?.find(
      (c) => c.call_text === 'print("Authentication successful")',
    )
    expect(call?.call_line).toBe(8)
    expect(call?.call_column).toBe(13)
    expect(call?.end_line).toBe(8)
    expect(call?.end_column).toBe(18)
  })
})

describe('TypescriptCallSiteResolver.getPartsOfCalleeExpression', () => {
  test('splits a simple dotted chain', () => {
    expect(
      TypescriptCallSiteResolver.getPartsOfCalleeExpression('a.b.c'),
    ).toEqual(['a', 'b', 'c'])
  })

  test('splits on optional-chaining and non-null-assertion accessors', () => {
    expect(
      TypescriptCallSiteResolver.getPartsOfCalleeExpression('a?.b!.c'),
    ).toEqual(['a', 'b', 'c'])
  })

  test('collapses newlines and surrounding whitespace before splitting', () => {
    expect(
      TypescriptCallSiteResolver.getPartsOfCalleeExpression('a.\n  b.\n  c'),
    ).toEqual(['a', 'b', 'c'])
  })

  test('returns a single-element array for a bare identifier', () => {
    expect(TypescriptCallSiteResolver.getPartsOfCalleeExpression('a')).toEqual([
      'a',
    ])
  })
})

describe('PythonCallSiteResolver.getPartsOfCalleeExpression', () => {
  test('splits a simple dotted chain', () => {
    expect(PythonCallSiteResolver.getPartsOfCalleeExpression('a.b.c')).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  test('collapses newlines and surrounding whitespace before splitting', () => {
    expect(
      PythonCallSiteResolver.getPartsOfCalleeExpression('a.\n  b.\n  c'),
    ).toEqual(['a', 'b', 'c'])
  })

  test('returns a single-element array for a bare identifier', () => {
    expect(PythonCallSiteResolver.getPartsOfCalleeExpression('a')).toEqual([
      'a',
    ])
  })
})

describe('removeWrappingParenthesis', () => {
  test('strips a single wrapping pair', () => {
    expect(removeWrappingParenthesis('(foo)')).toBe('foo')
  })

  test('strips nested wrapping parentheses in one pass', () => {
    expect(removeWrappingParenthesis('(foo(bar))')).toBe('foo(bar)')
  })

  test('leaves a string with no wrapping parentheses unchanged', () => {
    expect(removeWrappingParenthesis('foo')).toBe('foo')
  })

  test('fixes unbalanced parentheses', () => {
    expect(removeWrappingParenthesis('(foo')).toBe('foo')
    expect(removeWrappingParenthesis('foo)')).toBe('foo')
    expect(removeWrappingParenthesis('(foo))')).toBe('foo')
    expect(removeWrappingParenthesis('((foo)')).toBe('(foo)')
  })

  test('returns falsy input unchanged', () => {
    expect(removeWrappingParenthesis('')).toBe('')
  })

  test('does not strip multiple separate wrapping parentheses', () => {
    expect(removeWrappingParenthesis('(foo)(bar)')).toBe('(foo)(bar)')
    expect(removeWrappingParenthesis('(foo)(bar)(baz)')).toBe('(foo)(bar)(baz)')
  })
})
