import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'crypto'
import { join } from 'path'
import {
  GenericCallEdgeResolver,
  TypescriptCallEdgeResolver,
  PythonCallEdgeResolver,
  getConfidenceByCallResolutionSource,
  processImportedNames,
} from '../src/indexer/resolvers/callEdgeResolvers'
import {
  CallKind,
  CallTargetKind,
  CallResolutionSource,
  SymbolKind,
  ImportKind,
  EdgeKind,
  ResolutionSource,
  ResolvedKind,
  type IndexedCallSite,
} from '../src/database/schemas'
import { LspClient } from '../src/utils/LspClient'
import {
  getStoreForTests,
  getAppStateManagerForTests,
} from '../scripts/test_setup'
import type { IndexerDB } from '../src/database/IndexerDB'
import type { AppStateManager } from '../src/state'

let store: IndexerDB
let appStateManager: AppStateManager
let root: string

beforeAll(() => {
  store = getStoreForTests()
  appStateManager = getAppStateManagerForTests()
  root = appStateManager.getItem('root') as string
})

/** Builds a fully-populated fake call site row, only overriding the fields a given test cares about. */
function makeCallSite(
  overrides: Partial<IndexedCallSite['Select']>,
): IndexedCallSite['Select'] {
  return {
    id: randomUUID(),
    caller_id: randomUUID(),
    caller_file_path: 'file.ts',
    language_name: 'typescript',
    call_text: 'foo()',
    callee_expression: 'foo',
    callee_name: 'foo',
    callee_base: null,
    callee_property: null,
    call_kind: CallKind.FunctionCall,
    call_line: 1,
    call_column: 1,
    end_line: 1,
    end_column: 4,
    docstring: null,
    ...overrides,
  }
}

/** A stub LspClient that never actually starts a process: `supports()` and `request()` are monkey-patched per-test, and `ensureFileOpen` is a safe no-op because the client was never `start()`ed. */
function makeStubLspClient(
  options: {
    capabilities?: Record<string, unknown>
    request?: (method: string, params: any) => Promise<any>
  } = {},
): LspClient {
  const client = new LspClient([], root)
  ;(client as any).serverCapabilities = options.capabilities ?? {}
  if (options.request) {
    ;(client as any).request = options.request
  }
  return client
}

describe('callEdgeResolvers utils', () => {
  describe('getConfidenceByCallResolutionSource', () => {
    test('maps each resolution source to its expected confidence', () => {
      expect(
        getConfidenceByCallResolutionSource(CallResolutionSource.LspDefinition),
      ).toBe(100)
      expect(
        getConfidenceByCallResolutionSource(CallResolutionSource.SourceImport),
      ).toBe(90)
      expect(
        getConfidenceByCallResolutionSource(CallResolutionSource.SameFile),
      ).toBe(80)
      expect(
        getConfidenceByCallResolutionSource(CallResolutionSource.SameClass),
      ).toBe(75)
      expect(
        getConfidenceByCallResolutionSource(
          CallResolutionSource.ExternalImport,
        ),
      ).toBe(70)
      expect(
        getConfidenceByCallResolutionSource(CallResolutionSource.LspHover),
      ).toBe(60)
      expect(
        getConfidenceByCallResolutionSource(CallResolutionSource.BuiltinList),
      ).toBe(50)
      expect(
        getConfidenceByCallResolutionSource(
          CallResolutionSource.DynamicPattern,
        ),
      ).toBe(20)
      expect(
        getConfidenceByCallResolutionSource(CallResolutionSource.Unresolved),
      ).toBe(50)
    })

    test('returns 0 for an unrecognized resolution source', () => {
      expect(
        getConfidenceByCallResolutionSource('bogus' as CallResolutionSource),
      ).toBe(0)
    })
  })

  describe('processImportedNames', () => {
    test('returns an empty array for undefined/empty input', () => {
      expect(processImportedNames(undefined as unknown as string[])).toEqual([])
      expect(processImportedNames([])).toEqual([])
    })

    test('trims whitespace around names', () => {
      expect(processImportedNames(['  foo  '])).toEqual(['foo'])
    })

    test('skips names that are empty after trimming', () => {
      expect(processImportedNames(['foo', '   ', 'bar'])).toEqual([
        'foo',
        'bar',
      ])
    })

    test('excludes `type `-prefixed names by default', () => {
      expect(processImportedNames(['type Foo', 'bar'])).toEqual(['bar'])
    })

    test('keeps a type-prefixed name when includeTypeOnly is true', () => {
      expect(processImportedNames(['type Foo', 'bar'], true)).toEqual([
        'Foo',
        'bar',
      ])
    })

    test('strips a trailing `as alias` from each name', () => {
      expect(processImportedNames(['foo as bar', 'baz'])).toEqual([
        'foo',
        'baz',
      ])
    })

    test('processes a type only name that also has an alias', () => {
      expect(processImportedNames(['type Foo as Bar'], true)).toEqual(['Foo'])
    })
  })
})

describe('GenericCallEdgeResolver', () => {
  test('getPartsOfCalleeExpression is not implemented on the base class', () => {
    const resolver = new GenericCallEdgeResolver(
      makeStubLspClient(),
      'typescript',
    )
    expect(() => resolver.getPartsOfCalleeExpression('a.b')).toThrow(
      'Method not implemented.',
    )
  })

  describe('resolveDynamicCallEdges', () => {
    test('maps every call site to a Dynamic/DynamicPattern edge with confidence 20', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSites = [
        makeCallSite({ id: 'cs-1', caller_id: 'caller-1' }),
        makeCallSite({ id: 'cs-2', caller_id: 'caller-2' }),
      ]

      const edges = await resolver.resolveDynamicCallEdges(callSites)

      expect(edges).toHaveLength(2)
      expect(edges?.[0]?.call_site_id).toBe('cs-1')
      expect(edges?.[0]?.caller_id).toBe('caller-1')
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.Dynamic)
      expect(edges?.[0]?.resolution_source).toBe(
        CallResolutionSource.DynamicPattern,
      )
      expect(edges?.[0]?.confidence).toBe(20)
    })
  })

  describe('generateUnresolvedCallEdges', () => {
    test('maps every call site to an Unresolved/Unresolved edge', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSites = [makeCallSite({ id: 'cs-3', caller_id: 'caller-3' })]

      const edges = await resolver.generateUnresolvedCallEdges(callSites)

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.Unresolved)
      expect(edges?.[0]?.resolution_source).toBe(
        CallResolutionSource.Unresolved,
      )
      expect(edges?.[0]?.confidence).toBe(50)
    })
  })

  describe('resolveSameClassCallEdges', () => {
    const filePath = 'src/call-edges/class.ts'
    let classId: string
    let methodId: string
    let propId: string

    beforeAll(async () => {
      classId = randomUUID()
      methodId = randomUUID()
      propId = randomUUID()

      await store.files.upsert({
        path: filePath,
        hash: 'hash-class',
        language: 'typescript',
        estimated_tokens: 50,
      })
      await store.symbols.upsert([
        {
          id: classId,
          name: 'Widget',
          kind: SymbolKind.class,
          file_path: filePath,
          line: 1,
          column: 0,
          language: 'typescript',
        },
        {
          id: methodId,
          name: 'render',
          kind: SymbolKind.method,
          file_path: filePath,
          line: 2,
          column: 2,
          language: 'typescript',
          parent_id: classId,
        },
        {
          id: propId,
          name: 'helper',
          kind: SymbolKind.property,
          file_path: filePath,
          line: 3,
          column: 2,
          language: 'typescript',
          parent_id: classId,
        },
      ])
    })

    test('returns null when no call site is a `this.`-prefixed method call', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const edges = await resolver.resolveSameClassCallEdges([
        makeCallSite({ call_kind: CallKind.FunctionCall }),
      ])
      expect(edges).toBeNull()
    })

    test('matches a same-class method call directly by method name', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_id: classId,
        caller_file_path: filePath,
        call_kind: CallKind.MethodCall,
        callee_base: 'this',
        callee_property: 'render',
        callee_expression: 'this.render',
      })

      const edges = await resolver.resolveSameClassCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.callee_id).toBe(methodId)
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.ProjectSymbol)
      expect(edges?.[0]?.resolution_source).toBe(CallResolutionSource.SameClass)
      expect(edges?.[0]?.confidence).toBe(75)
    })

    test('falls back to matching a same-class property prefix when no method matches by name', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_id: classId,
        caller_file_path: filePath,
        call_kind: CallKind.MethodCall,
        callee_base: 'this.helper',
        callee_property: 'doSomething',
        callee_expression: 'this.helper.doSomething',
      })

      const edges = await resolver.resolveSameClassCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.callee_id).toBe(propId)
    })

    test('accepts custom classMethodIdentifiers instead of the "this" default', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_id: classId,
        caller_file_path: filePath,
        call_kind: CallKind.MethodCall,
        callee_base: 'self',
        callee_property: 'render',
        callee_expression: 'self.render',
      })

      const edges = await resolver.resolveSameClassCallEdges(
        [callSite],
        ['self'],
      )

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.callee_id).toBe(methodId)
    })
  })

  describe('resolveSameFileCallEdges', () => {
    const filePath = 'src/call-edges/file1.ts'
    let fnId: string
    let letId: string
    let letParentId: string

    beforeAll(async () => {
      fnId = randomUUID()
      letId = randomUUID()
      letParentId = randomUUID()

      await store.files.upsert({
        path: filePath,
        hash: 'hash-file1',
        language: 'typescript',
        estimated_tokens: 50,
      })
      await store.symbols.upsert([
        {
          id: fnId,
          name: 'helperFn',
          kind: SymbolKind.function,
          file_path: filePath,
          line: 1,
          column: 0,
          language: 'typescript',
        },
        {
          id: letParentId,
          name: 'containingFn',
          kind: SymbolKind.function,
          file_path: filePath,
          line: 5,
          column: 0,
          language: 'typescript',
        },
        {
          id: letId,
          name: 'handler',
          kind: SymbolKind.const,
          file_path: filePath,
          line: 6,
          column: 2,
          language: 'typescript',
          parent_id: letParentId,
        },
      ])
    })

    test('matches a callable symbol declared in the same file', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_file_path: filePath,
        callee_name: 'helperFn',
        callee_expression: 'helperFn',
        call_kind: CallKind.FunctionCall,
      })

      const edges = await resolver.resolveSameFileCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.callee_id).toBe(fnId)
      expect(edges?.[0]?.resolution_source).toBe(CallResolutionSource.SameFile)
      expect(edges?.[0]?.confidence).toBe(80)
    })

    test('matches a lexical (const/let/var) symbol whose parent is the calling symbol', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_id: letParentId,
        caller_file_path: filePath,
        callee_expression: 'handler.run',
        callee_name: 'run',
        callee_base: 'handler',
        call_kind: CallKind.MethodCall,
      })

      const edges = await resolver.resolveSameFileCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.callee_id).toBe(letId)
    })

    test('returns an empty array when the file has no indexed symbols', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({ caller_file_path: 'src/no-symbols.ts' })

      const edges = await resolver.resolveSameFileCallEdges([callSite])

      expect(edges).toEqual([])
    })
  })

  describe('resolveImportBoundCallEdges', () => {
    const filePath = 'src/call-edges/importer.ts'

    beforeAll(async () => {
      await store.files.upsert({
        path: filePath,
        hash: 'hash-importer',
        language: 'typescript',
        estimated_tokens: 50,
      })
      await store.imports.upsert([
        {
          id: randomUUID(),
          file_path: filePath,
          sourceModule: 'some-external-lib',
          importedNames: ['doExternalThing'],
          edgeKind: EdgeKind.Import,
          importKind: ImportKind.Named,
          resolutionSource: ResolutionSource.Bun,
          resolvedKind: ResolvedKind.Package,
          isExternal: true,
        },
        {
          id: randomUUID(),
          file_path: filePath,
          sourceModule: './local-module',
          importedNames: ['doLocalThing'],
          edgeKind: EdgeKind.Import,
          importKind: ImportKind.Named,
          resolutionSource: ResolutionSource.Bun,
          resolvedKind: ResolvedKind.Source,
          isExternal: false,
        },
        {
          id: randomUUID(),
          file_path: filePath,
          sourceModule: './side-effect-module',
          importedNames: ['excludedName'],
          edgeKind: EdgeKind.Import,
          importKind: ImportKind.SideEffect,
          resolutionSource: ResolutionSource.Bun,
          resolvedKind: ResolvedKind.Source,
          isExternal: false,
        },
      ])
    })

    test('resolves a call to an external import as ExternalImport with confidence 70', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_file_path: filePath,
        callee_name: 'doExternalThing',
        callee_expression: 'doExternalThing',
      })

      const edges = await resolver.resolveImportBoundCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.Import)
      expect(edges?.[0]?.resolution_source).toBe(
        CallResolutionSource.ExternalImport,
      )
      expect(edges?.[0]?.confidence).toBe(70)
    })

    test('resolves a call to an internal import as SourceImport with confidence 90', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_file_path: filePath,
        callee_name: 'doLocalThing',
        callee_expression: 'doLocalThing',
      })

      const edges = await resolver.resolveImportBoundCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.resolution_source).toBe(
        CallResolutionSource.SourceImport,
      )
      expect(edges?.[0]?.confidence).toBe(90)
    })

    test('matches via callee_base as well as callee_name', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_file_path: filePath,
        callee_name: 'someMethod',
        callee_base: 'doLocalThing',
        callee_expression: 'doLocalThing.someMethod',
        call_kind: CallKind.MethodCall,
      })

      const edges = await resolver.resolveImportBoundCallEdges([callSite])

      expect(edges).toHaveLength(1)
    })

    test('does not match a side-effect import even if the name coincidentally matches', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        caller_file_path: filePath,
        callee_name: 'excludedName',
        callee_expression: 'excludedName',
      })

      const edges = await resolver.resolveImportBoundCallEdges([callSite])

      expect(edges).toEqual([])
    })

    test('returns an empty array when the file has no imports', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({ caller_file_path: 'src/no-imports.ts' })

      const edges = await resolver.resolveImportBoundCallEdges([callSite])

      expect(edges).toEqual([])
    })
  })

  describe('resolveGlobalListBuiltInCallEdges', () => {
    test('matches a typescript builtin function call by callee_name', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        callee_name: 'parseInt',
        call_kind: CallKind.FunctionCall,
      })

      const edges = await resolver.resolveGlobalListBuiltInCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.Builtin)
      expect(edges?.[0]?.resolution_source).toBe(
        CallResolutionSource.BuiltinList,
      )
      expect(edges?.[0]?.confidence).toBe(50)
    })

    test('matches a typescript builtin via callee_base for a method call', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({
        callee_name: 'from',
        callee_base: 'Array',
        call_kind: CallKind.MethodCall,
      })

      const edges = await resolver.resolveGlobalListBuiltInCallEdges([callSite])

      expect(edges).toHaveLength(1)
    })

    test('returns an empty array when the callee is not a known builtin', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient(),
        'typescript',
      )
      const callSite = makeCallSite({ callee_name: 'myOwnFunction' })

      const edges = await resolver.resolveGlobalListBuiltInCallEdges([callSite])

      expect(edges).toEqual([])
    })

    test('returns an empty array for a language with no configured builtins', async () => {
      const resolver = new GenericCallEdgeResolver(makeStubLspClient(), 'rust')
      const callSite = makeCallSite({ callee_name: 'parseInt' })

      const edges = await resolver.resolveGlobalListBuiltInCallEdges([callSite])

      expect(edges).toEqual([])
    })
  })

  describe('resolveLSPDefinitionCallEdges', () => {
    test('returns null when the LSP client does not support definitionProvider', async () => {
      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({ capabilities: {} }),
        'typescript',
      )
      const edges = await resolver.resolveLSPDefinitionCallEdges([
        makeCallSite({}),
      ])
      expect(edges).toBeNull()
    })

    test('returns null when the workspace root is not set', async () => {
      appStateManager.deleteItem('root')
      try {
        const resolver = new TypescriptCallEdgeResolver(
          makeStubLspClient({ capabilities: { definitionProvider: true } }),
          'typescript',
        )
        const edges = await resolver.resolveLSPDefinitionCallEdges([
          makeCallSite({ call_line: 1, call_column: 1 }),
        ])
        expect(edges).toBeNull()
      } finally {
        appStateManager.setItem('root', root)
      }
    })

    test('resolves to a matching project symbol at the definition location', async () => {
      const targetPath = 'src/call-edges/target-def.ts'
      const targetId = randomUUID()
      await store.files.upsert({
        path: targetPath,
        hash: 'hash-target-def',
        language: 'typescript',
        estimated_tokens: 20,
      })
      await store.symbols.upsert([
        {
          id: targetId,
          name: 'targetFn',
          kind: SymbolKind.function,
          file_path: targetPath,
          line: 10,
          column: 2,
          language: 'typescript',
        },
      ])

      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({
          capabilities: { definitionProvider: true },
          request: async () => [
            {
              uri: `file://${join(root, targetPath)}`,
              range: { start: { line: 10, character: 2 } },
            },
          ],
        }),
        'typescript',
      )

      const callSite = makeCallSite({
        caller_file_path: 'src/call-edges/caller-def.ts',
        call_line: 5,
        call_column: 3,
        callee_name: 'targetFn',
        callee_expression: 'targetFn',
      })

      const edges = await resolver.resolveLSPDefinitionCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.ProjectSymbol)
      expect(edges?.[0]?.callee_id).toBe(targetId)
      expect(edges?.[0]?.resolution_source).toBe(
        CallResolutionSource.LspDefinition,
      )
      expect(edges?.[0]?.confidence).toBe(100)
    })

    test('resolves to a Builtin edge when the definition falls under a configured lang_features_paths entry', async () => {
      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({
          capabilities: { definitionProvider: true },
          request: async () => [
            {
              uri: `file://${join(root, 'node_modules/typescript/lib/lib.es5.d.ts')}`,
              range: { start: { line: 0, character: 0 } },
            },
          ],
        }),
        'typescript',
      )

      const callSite = makeCallSite({
        caller_file_path: 'src/call-edges/caller-def.ts',
        call_line: 6,
        call_column: 3,
        callee_name: 'parseInt',
        callee_expression: 'parseInt',
      })

      const edges = await resolver.resolveLSPDefinitionCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.Builtin)
      expect(edges?.[0]?.resolution_source).toBe(
        CallResolutionSource.LspDefinition,
      )
    })

    test('resolves to a matching import when the definition lands in the same directory as a resolved import', async () => {
      const callerPath = 'src/call-edges/import-fallback-caller.ts'
      const importId = randomUUID()
      await store.files.upsert({
        path: callerPath,
        hash: 'hash-import-fallback',
        language: 'typescript',
        estimated_tokens: 20,
      })
      await store.imports.upsert([
        {
          id: importId,
          file_path: callerPath,
          sourceModule: './sibling',
          importedNames: ['siblingThing'],
          resolvedPath: 'src/call-edges/sibling-dir/target.ts',
          edgeKind: EdgeKind.Import,
          importKind: ImportKind.Named,
          resolutionSource: ResolutionSource.Bun,
          resolvedKind: ResolvedKind.Source,
          isExternal: false,
        },
      ])

      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({
          capabilities: { definitionProvider: true },
          request: async () => [
            {
              uri: `file://${join(root, 'src/call-edges/sibling-dir/other.ts')}`,
              range: { start: { line: 0, character: 0 } },
            },
          ],
        }),
        'typescript',
      )

      const callSite = makeCallSite({
        caller_file_path: callerPath,
        call_line: 2,
        call_column: 1,
        callee_name: 'siblingThing',
        callee_expression: 'siblingThing',
      })

      const edges = await resolver.resolveLSPDefinitionCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.Import)
      expect(edges?.[0]?.imports_id).toBe(importId)
    })

    test('continues to the next call site when the LSP request throws', async () => {
      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({
          capabilities: { definitionProvider: true },
          request: async () => {
            throw new Error('server crashed')
          },
        }),
        'typescript',
      )

      const edges = await resolver.resolveLSPDefinitionCallEdges([
        makeCallSite({
          caller_file_path: 'src/call-edges/caller-def.ts',
          call_line: 1,
          call_column: 1,
        }),
      ])

      expect(edges).toEqual([])
    })
  })

  describe('resolveLSPHoverCallEdges', () => {
    test('returns null when the LSP client does not support hoverProvider', async () => {
      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({ capabilities: {} }),
        'typescript',
      )
      const edges = await resolver.resolveLSPHoverCallEdges([makeCallSite({})])
      expect(edges).toBeNull()
    })

    test('returns null when the workspace root is not set', async () => {
      appStateManager.deleteItem('root')
      try {
        const resolver = new TypescriptCallEdgeResolver(
          makeStubLspClient({ capabilities: { hoverProvider: true } }),
          'typescript',
        )
        const edges = await resolver.resolveLSPHoverCallEdges([
          makeCallSite({ call_line: 1, call_column: 1 }),
        ])
        expect(edges).toBeNull()
      } finally {
        appStateManager.setItem('root', root)
      }
    })

    test('resolves a matching import from the hover signature type, reading real file content for the hover column', async () => {
      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({
          capabilities: { hoverProvider: true },
          request: async () => ({ contents: 'x: fs' }),
        }),
        'typescript',
      )

      const callSite = makeCallSite({
        caller_file_path: 'math.ts',
        call_line: 60,
        call_column: 17,
        call_text: 'Math.sqrt(dx * dx + dy * dy)',
        callee_expression: 'Math.sqrt',
        callee_name: 'sqrt',
        callee_base: 'Math',
        call_kind: CallKind.MethodCall,
      })

      const edges = await resolver.resolveLSPHoverCallEdges([callSite])

      expect(edges).toHaveLength(1)
      expect(edges?.[0]?.target_kind).toBe(CallTargetKind.Import)
      expect(edges?.[0]?.resolution_source).toBe(CallResolutionSource.LspHover)
      expect(edges?.[0]?.confidence).toBe(60)
    })

    test('returns an empty array when the hover response has no usable content', async () => {
      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({
          capabilities: { hoverProvider: true },
          request: async () => null,
        }),
        'typescript',
      )

      const callSite = makeCallSite({
        caller_file_path: 'math.ts',
        call_line: 57,
        call_column: 17,
        call_text: 'Math.sqrt(dx * dx + dy * dy)',
        callee_expression: 'Math.sqrt',
        callee_name: 'sqrt',
        callee_base: 'Math',
        call_kind: CallKind.MethodCall,
      })

      const edges = await resolver.resolveLSPHoverCallEdges([callSite])

      expect(edges).toEqual([])
    })

    test('skips a call site with no call_line/call_column', async () => {
      const resolver = new TypescriptCallEdgeResolver(
        makeStubLspClient({ capabilities: { hoverProvider: true } }),
        'typescript',
      )

      const edges = await resolver.resolveLSPHoverCallEdges([
        makeCallSite({ call_line: null, call_column: null }),
      ])

      expect(edges).toEqual([])
    })
  })

  describe('resolveCallEdges (orchestration)', () => {
    test('routes dynamic calls through resolveDynamicCallEdges and everything else falls through to unresolved when nothing else matches', async () => {
      const resolver = new GenericCallEdgeResolver(
        makeStubLspClient({ capabilities: {} }), // LSP steps are unsupported -> null, skipped
        'typescript',
      )

      const dynamicCallSite = makeCallSite({
        id: 'dyn-1',
        call_kind: CallKind.DynamicCall,
      })
      const plainCallSite = makeCallSite({
        id: 'plain-1',
        call_kind: CallKind.FunctionCall,
        callee_name: 'someTotallyUnknownFunctionXyz',
        caller_file_path: 'src/call-edges/nowhere.ts',
      })

      const edges = await resolver.resolveCallEdges([
        dynamicCallSite,
        plainCallSite,
      ])

      expect(edges).toHaveLength(2)
      const dynEdge = edges.find((e) => e.call_site_id === 'dyn-1')
      const unresolvedEdge = edges.find((e) => e.call_site_id === 'plain-1')

      expect(dynEdge?.resolution_source).toBe(
        CallResolutionSource.DynamicPattern,
      )
      expect(unresolvedEdge?.resolution_source).toBe(
        CallResolutionSource.Unresolved,
      )
    })
  })
})

describe('TypescriptCallEdgeResolver', () => {
  test('getPartsOfCalleeExpression splits a dotted chain', () => {
    const resolver = new TypescriptCallEdgeResolver(
      makeStubLspClient(),
      'typescript',
    )
    expect(resolver.getPartsOfCalleeExpression('a.b.c')).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  test('getPartsOfCalleeExpression strips generic type parameters from each part', () => {
    const resolver = new TypescriptCallEdgeResolver(
      makeStubLspClient(),
      'typescript',
    )
    expect(resolver.getPartsOfCalleeExpression('Foo<Bar>.baz')).toEqual([
      'Foo',
      'baz',
    ])
  })

  test('resolveSameClassCallEdges defaults classMethodIdentifiers to ["this"]', async () => {
    const filePath = 'src/call-edges/ts-default-identifier.ts'
    const classId = randomUUID()
    const methodId = randomUUID()
    await store.files.upsert({
      path: filePath,
      hash: 'hash-ts-default',
      language: 'typescript',
      estimated_tokens: 20,
    })
    await store.symbols.upsert([
      {
        id: classId,
        name: 'TsWidget',
        kind: SymbolKind.class,
        file_path: filePath,
        line: 1,
        column: 0,
        language: 'typescript',
      },
      {
        id: methodId,
        name: 'render',
        kind: SymbolKind.method,
        file_path: filePath,
        line: 2,
        column: 2,
        language: 'typescript',
        parent_id: classId,
      },
    ])

    const resolver = new TypescriptCallEdgeResolver(
      makeStubLspClient(),
      'typescript',
    )
    const callSite = makeCallSite({
      caller_id: classId,
      caller_file_path: filePath,
      call_kind: CallKind.MethodCall,
      callee_base: 'this',
      callee_property: 'render',
      callee_expression: 'this.render',
    })

    const edges = await resolver.resolveSameClassCallEdges([callSite])

    expect(edges).toHaveLength(1)
    expect(edges?.[0]?.callee_id).toBe(methodId)
  })
})

describe('PythonCallEdgeResolver', () => {
  test('getPartsOfCalleeExpression splits a dotted chain', () => {
    const resolver = new PythonCallEdgeResolver(makeStubLspClient(), 'python')
    expect(resolver.getPartsOfCalleeExpression('a.b.c')).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  test('resolveSameClassCallEdges defaults classMethodIdentifiers to ["self"]', async () => {
    const filePath = 'src/call-edges/py_default_identifier.py'
    const classId = randomUUID()
    const methodId = randomUUID()
    await store.files.upsert({
      path: filePath,
      hash: 'hash-py-default',
      language: 'python',
      estimated_tokens: 20,
    })
    await store.symbols.upsert([
      {
        id: classId,
        name: 'PyWidget',
        kind: SymbolKind.class,
        file_path: filePath,
        line: 1,
        column: 0,
        language: 'python',
      },
      {
        id: methodId,
        name: 'render',
        kind: SymbolKind.method,
        file_path: filePath,
        line: 2,
        column: 2,
        language: 'python',
        parent_id: classId,
      },
    ])

    const resolver = new PythonCallEdgeResolver(makeStubLspClient(), 'python')
    const callSite = makeCallSite({
      caller_id: classId,
      caller_file_path: filePath,
      call_kind: CallKind.MethodCall,
      callee_base: 'self',
      callee_property: 'render',
      callee_expression: 'self.render',
      language_name: 'python',
    })

    const edges = await resolver.resolveSameClassCallEdges([callSite])

    expect(edges).toHaveLength(1)
    expect(edges?.[0]?.callee_id).toBe(methodId)
  })
})
