import { describe, expect, test } from 'bun:test'
import { getBuiltins } from '../src/constants/callEdgeBuiltins'
import { TS_JS_GLOBAL_OBJECTS } from '../src/constants/callEdgeBuiltins/tsJsObjs'
import { TS_JS_GLOBAL_CALLS } from '../src/constants/callEdgeBuiltins/tsJsCalls'
import { PY_GLOBAL_CALLS } from '../src/constants/callEdgeBuiltins/pyCalls'
import { CallKind } from '../src/database/schemas'
import type { SupportedLanguage } from 'tree-sitter-wasm'

describe('callEdgeBuiltins', () => {
  describe('getBuiltins', () => {
    test('returns the global function set for typescript function calls', () => {
      const result = getBuiltins('typescript', CallKind.FunctionCall)
      expect(result).toBe(TS_JS_GLOBAL_CALLS)
      expect(result?.has('parseInt')).toBe(true)
      expect(result?.has('fetch')).toBe(true)
    })

    test('returns the global objects set for typescript method calls', () => {
      const result = getBuiltins('typescript', CallKind.MethodCall)
      expect(result).toBe(TS_JS_GLOBAL_OBJECTS)
      expect(result?.has('console')).toBe(true)
      expect(result?.has('Array')).toBe(true)
    })

    test('returns the global objects set for typescript constructor calls', () => {
      const result = getBuiltins('typescript', CallKind.ConstructorCall)
      expect(result).toBe(TS_JS_GLOBAL_OBJECTS)
      expect(result?.has('Map')).toBe(true)
    })

    test('returns undefined for typescript call kinds with no configured builtins', () => {
      expect(getBuiltins('typescript', CallKind.DecoratorCall)).toBeUndefined()
      expect(getBuiltins('typescript', CallKind.SuperCall)).toBeUndefined()
      expect(getBuiltins('typescript', CallKind.DynamicCall)).toBeUndefined()
      expect(getBuiltins('typescript', CallKind.Unknown)).toBeUndefined()
    })

    test('returns the global function set for python function calls', () => {
      const result = getBuiltins('python', CallKind.FunctionCall)
      expect(result).toBe(PY_GLOBAL_CALLS)
      expect(result?.has('print')).toBe(true)
      expect(result?.has('len')).toBe(true)
    })

    test('returns undefined for python call kinds with no configured builtins', () => {
      expect(getBuiltins('python', CallKind.MethodCall)).toBeUndefined()
      expect(getBuiltins('python', CallKind.ConstructorCall)).toBeUndefined()
    })

    test('returns undefined for a language with no configured builtins at all', () => {
      expect(
        getBuiltins('rust' as SupportedLanguage, CallKind.FunctionCall),
      ).toBeUndefined()
    })
  })

  describe('TS_JS_GLOBAL_OBJECTS', () => {
    test('contains core JS constructors, collections, errors, and platform globals', () => {
      for (const name of [
        'Array',
        'Object',
        'Promise',
        'Map',
        'Set',
        'Error',
        'TypeError',
        'console',
        'process',
        'Buffer',
        'URL',
        'Bun',
      ]) {
        expect(TS_JS_GLOBAL_OBJECTS.has(name)).toBe(true)
      }
    })

    test('does not contain arbitrary non-global identifiers', () => {
      expect(TS_JS_GLOBAL_OBJECTS.has('myCustomClass')).toBe(false)
    })
  })

  describe('TS_JS_GLOBAL_CALLS', () => {
    test('contains parsing, timer, and encoding globals', () => {
      for (const name of [
        'parseInt',
        'parseFloat',
        'setTimeout',
        'fetch',
        'encodeURIComponent',
        'require',
      ]) {
        expect(TS_JS_GLOBAL_CALLS.has(name)).toBe(true)
      }
    })

    test('includes constructors that are commonly called without new', () => {
      expect(TS_JS_GLOBAL_CALLS.has('Date')).toBe(true)
      expect(TS_JS_GLOBAL_CALLS.has('Error')).toBe(true)
    })
  })

  describe('PY_GLOBAL_CALLS', () => {
    test('contains I/O, introspection, type constructors, and collection builtins', () => {
      for (const name of [
        'print',
        'isinstance',
        'getattr',
        'str',
        'list',
        'dict',
        'len',
        'sorted',
        'super',
      ]) {
        expect(PY_GLOBAL_CALLS.has(name)).toBe(true)
      }
    })

    test('contains commonly constructed exception types', () => {
      for (const name of [
        'Exception',
        'ValueError',
        'TypeError',
        'KeyError',
        'StopIteration',
      ]) {
        expect(PY_GLOBAL_CALLS.has(name)).toBe(true)
      }
    })

    test('does not contain arbitrary non-builtin identifiers', () => {
      expect(PY_GLOBAL_CALLS.has('my_custom_function')).toBe(false)
    })
  })
})
