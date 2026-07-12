import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import { join } from 'path'
import { BunImportResolver } from '../src/indexer/importResolver/BunImportResolver'
import { TypescriptImportResolver } from '../src/indexer/importResolver/TypescriptImportResolver'
import { PythonImportResolver } from '../src/indexer/importResolver/PythonImportResolver'
import { ChainedImportResolver } from '../src/indexer/importResolver/ChainedImportResolver'
import type { ImportResolver } from '../src/indexer/importResolver/ImportResolver'
import {
  EdgeKind,
  ImportKind,
  ResolvedKind,
  ResolutionSource,
  type ImportResolutionResult,
} from 'src/database/schemas'
import { getAppStateManagerForTests } from '../scripts/test_setup'
import type { AppStateManager } from 'src/state'
import type { IndexerConfig } from 'src/config/types'

// TypescriptImportResolver locates its nearest tsconfig by comparing
// `dirname(containingFile)` against the project root using bare
// `path.relative`, which falls back to `process.cwd()` for relative inputs.
// Passing an absolute containingFile sidesteps that (see the dedicated
// "known issues" describe block below for the relative-path case).
let ROOT: string
let absApp: string

beforeAll(() => {
  ROOT = getAppStateManagerForTests().getItem('root') as string
  absApp = join(ROOT, 'app.ts')
})

describe('BunImportResolver', () => {
  let resolver: BunImportResolver

  beforeAll(() => {
    resolver = new BunImportResolver('typescript')
  })

  test('resolves a node: builtin', () => {
    const result = resolver.resolve(
      'node:fs',
      absApp,
      ['fs'],
      ImportKind.Namespace,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.BuiltIn)
    expect(result?.isExternal).toBe(true)
    expect(result?.resolutionSource).toBe(ResolutionSource.Bun)
    expect(result?.isRuntimeDependency).toBe(true)
  })

  test('resolves a bun: builtin', () => {
    const result = resolver.resolve(
      'bun:ffi',
      absApp,
      ['ffi'],
      ImportKind.Namespace,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.BuiltIn)
    expect(result?.isExternal).toBe(true)
    expect(result?.resolutionSource).toBe(ResolutionSource.Bun)
    expect(result?.isRuntimeDependency).toBe(true)
  })

  test('resolves a relative import to a source file', () => {
    const result = resolver.resolve(
      './math',
      'app.ts',
      ['add'],
      ImportKind.Named,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.resolvedPath).toBe('math.ts')
    expect(result?.isExternal).toBe(false)
  })

  test('resolves an asset import by extension', () => {
    const result = resolver.resolve(
      './assets/config.json',
      'app.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Asset)
  })

  test('stores an unresolved import instead of returning null', () => {
    const result = resolver.resolve(
      './does-not-exist',
      'app.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result).not.toBeNull()
    expect(result?.resolvedKind).toBe(ResolvedKind.Unresolved)
    expect(result?.confidence).toBe(0)
    expect(result?.resolutionSource).toBe(ResolutionSource.Unresolved)
    expect(result?.reason).toBeTruthy()
  })

  test('resolves a real external package by walking up to an ancestor node_modules', () => {
    const result = resolver.resolve(
      'zod',
      'app.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Package)
    expect(result?.isExternal).toBe(true)
  })

  test('preserves a bare package specifier as sourceModule', () => {
    const result = resolver.resolve(
      'zod',
      'app.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result?.sourceModule).toBe('zod')
  })
})

describe('TypescriptImportResolver', () => {
  let resolver: TypescriptImportResolver

  beforeAll(() => {
    resolver = new TypescriptImportResolver('typescript')
  })

  test('resolves a relative import to a source file', () => {
    const result = resolver.resolve(
      './math',
      absApp,
      ['add'],
      ImportKind.Named,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.resolvedPath).toBe('math.ts')
    expect(result?.resolutionSource).toBe(ResolutionSource.Typescript)
    expect(result?.isExternal).toBe(false)
  })

  test('resolves a tsconfig path alias', () => {
    const result = resolver.resolve(
      '@utils/helper',
      absApp,
      ['helper'],
      ImportKind.Named,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.resolvedPath).toBe(join('utils', 'helper.ts'))
  })

  test('marks a type-only import as not a runtime dependency', () => {
    const result = resolver.resolve(
      './math',
      absApp,
      ['type Shape'],
      ImportKind.TypeOnly,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.importKind).toBe(ImportKind.TypeOnly)
    expect(result?.isRuntimeDependency).toBe(false)
  })

  test('resolves a side-effect import with no imported names', () => {
    const result = resolver.resolve(
      './math',
      absApp,
      [],
      ImportKind.SideEffect,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.importKind).toBe(ImportKind.SideEffect)
    expect(result?.importedNames).toEqual([])
    expect(result?.isRuntimeDependency).toBe(true)
  })

  test('resolves a re-export edge distinctly from a plain import', () => {
    const result = resolver.resolve(
      './math',
      absApp,
      ['add'],
      ImportKind.Named,
      EdgeKind.ReExport,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.edgeKind).toBe(EdgeKind.ReExport)
  })

  test('resolves a node: builtin', () => {
    const result = resolver.resolve(
      'node:path',
      absApp,
      [],
      ImportKind.SideEffect,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.BuiltIn)
    expect(result?.isExternal).toBe(true)
    expect(result?.resolutionSource).toBe(ResolutionSource.Typescript)
  })

  test('resolves a bun: builtin', () => {
    const result = resolver.resolve(
      'bun:ffi',
      absApp,
      [],
      ImportKind.SideEffect,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.BuiltIn)
    expect(result?.isExternal).toBe(true)
    expect(result?.resolutionSource).toBe(ResolutionSource.Typescript)
  })

  test('resolves an asset import by extension', () => {
    const result = resolver.resolve(
      './assets/config.json',
      absApp,
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Asset)
  })

  test('stores an unresolved import instead of returning null', () => {
    const result = resolver.resolve(
      './does-not-exist',
      absApp,
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result).not.toBeNull()
    expect(result?.resolvedKind).toBe(ResolvedKind.Unresolved)
    expect(result?.confidence).toBe(0)
    expect(result?.resolutionSource).toBe(ResolutionSource.Unresolved)
  })
})

describe('PythonImportResolver', () => {
  let resolver: PythonImportResolver

  beforeAll(() => {
    resolver = new PythonImportResolver('python')
  })

  test('resolves a plain "import x" to a source module', () => {
    const result = resolver.resolve(
      'auth',
      'app.py',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.resolutionSource).toBe(ResolutionSource.PythonStatic)
    expect(result?.resolvedPath).toBe('auth.py')
    expect(result?.sourceModule).toBe('auth')
  })

  test('resolves "from x import y" and keeps the imported names', () => {
    const result = resolver.resolve(
      'auth',
      'app.py',
      ['Authenticator'],
      ImportKind.Named,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.resolvedPath).toBe('auth.py')
    expect(result?.importedNames).toEqual(['Authenticator'])
  })

  test('resolves "from .x import y" (single-dot, same-package relative import)', () => {
    const result = resolver.resolve(
      '.auth',
      'app.py',
      ['Authenticator'],
      ImportKind.Named,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.resolvedPath).toBe('auth.py')
    expect(result?.sourceModule).toBe('auth')
  })

  test('resolves "from ..x import y" (double-dot, parent-package relative import)', () => {
    const result = resolver.resolve(
      '..other',
      join('pkg', 'subpkg', 'mod.py'),
      ['shared'],
      ImportKind.Named,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.Source)
    expect(result?.resolvedPath).toBe(join('pkg', 'other.py'))
    expect(result?.sourceModule).toBe('other')
  })

  test('resolves a stdlib import via importlib', () => {
    const result = resolver.resolve(
      'json',
      'app.py',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result?.resolvedKind).toBe(ResolvedKind.StdLib)
    expect(result?.resolutionSource).toBe(ResolutionSource.PythonImportlib)
    expect(result?.isExternal).toBe(true)
  })

  test('classifies a real third-party package as ResolvedKind.Package', () => {
    const result = resolver.resolve(
      'annotated_types',
      'app.py',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result?.resolutionSource).toBe(ResolutionSource.PythonImportlib)
    expect(result?.isExternal).toBe(true)
    expect(result?.resolvedKind).toBe(ResolvedKind.Package)
  })

  test('stores an unresolved import instead of returning null', () => {
    const result = resolver.resolve(
      'totally_fake_module_xyz',
      'app.py',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result).not.toBeNull()
    expect(result?.resolvedKind).toBe(ResolvedKind.Unresolved)
    expect(result?.confidence).toBe(0)
    expect(result?.reason).toContain('totally_fake_module_xyz')
  })

  describe('with importlib disabled', () => {
    let appStateManager: AppStateManager
    let originalConfig: IndexerConfig | undefined

    afterAll(() => {
      if (originalConfig) {
        appStateManager.setItem('config', originalConfig)
      }
    })

    test('returns unresolved for a module with no local source instead of shelling out to python', () => {
      appStateManager = getAppStateManagerForTests()
      originalConfig = appStateManager.getItem('config')
      if (!originalConfig?.languages.python?.import_resolution?.python) {
        throw new Error('Expected python import_resolution config to exist')
      }

      appStateManager.setItem('config', {
        ...originalConfig,
        languages: {
          ...originalConfig.languages,
          python: {
            ...originalConfig.languages.python,
            import_resolution: {
              ...originalConfig.languages.python.import_resolution,
              python: {
                ...originalConfig.languages.python.import_resolution.python,
                use_importlib: false,
              },
            },
          },
        },
      })

      const noImportlibResolver = new PythonImportResolver('python')
      const result = noImportlibResolver.resolve(
        'json',
        'app.py',
        [],
        ImportKind.Default,
        EdgeKind.Import,
      )
      expect(result?.resolvedKind).toBe(ResolvedKind.Unresolved)
      expect(result?.reason).toContain('Importlib is disabled')
    })
  })
})

describe('ChainedImportResolver', () => {
  test('returns the first resolver result that is not Unresolved', () => {
    const unresolved: ImportResolutionResult = {
      sourceModule: 'x',
      edgeKind: EdgeKind.Import,
      importedNames: [],
      importKind: ImportKind.Default,
      resolvedPath: null,
      resolutionSource: ResolutionSource.Unresolved,
      isExternal: false,
      confidence: 0,
      reason: 'first resolver could not resolve',
      resolvedKind: ResolvedKind.Unresolved,
      isRuntimeDependency: false,
    }
    const resolved: ImportResolutionResult = {
      ...unresolved,
      resolutionSource: ResolutionSource.Manual,
      resolvedKind: ResolvedKind.Source,
      resolvedPath: 'x.ts',
      confidence: 1,
      reason: null,
    }

    let secondCalled = false
    const first: ImportResolver = { resolve: () => unresolved }
    const second: ImportResolver = {
      resolve: () => {
        secondCalled = true
        return resolved
      },
    }
    const third: ImportResolver = {
      resolve: () => {
        throw new Error(
          'should not be reached once the second resolver succeeds',
        )
      },
    }

    const chain = new ChainedImportResolver([first, second, third])
    const result = chain.resolve(
      'x',
      'file.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )

    expect(secondCalled).toBe(true)
    expect(result).toEqual(resolved)
  })

  test('returns null when every resolver returns null', () => {
    const chain = new ChainedImportResolver([
      { resolve: () => null },
      { resolve: () => null },
    ])
    const result = chain.resolve(
      'x',
      'file.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result).toBeNull()
  })

  test('returns the last unresolved result when no resolver succeeds', () => {
    const first: ImportResolutionResult = {
      sourceModule: 'x',
      edgeKind: EdgeKind.Import,
      importedNames: [],
      importKind: ImportKind.Default,
      resolvedPath: null,
      resolutionSource: ResolutionSource.Unresolved,
      isExternal: false,
      confidence: 0,
      reason: 'from first resolver',
      resolvedKind: ResolvedKind.Unresolved,
      isRuntimeDependency: false,
    }
    const second: ImportResolutionResult = {
      ...first,
      reason: 'from second resolver',
    }

    const chain = new ChainedImportResolver([
      { resolve: () => first },
      { resolve: () => second },
    ])
    const result = chain.resolve(
      'x',
      'file.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result?.reason).toBe('from second resolver')
  })

  test('catches a resolver that throws and returns an unresolved result instead of crashing', () => {
    const chain = new ChainedImportResolver([
      {
        resolve: () => {
          throw new Error('boom')
        },
      },
    ])
    const result = chain.resolve(
      'x',
      'file.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )
    expect(result).not.toBeNull()
    expect(result?.resolvedKind).toBe(ResolvedKind.Unresolved)
    expect(result?.reason).toContain('boom')
  })
})

describe('TypescriptImportResolver + relative containingFile', () => {
  test('resolves correctly when containingFile is relative to the project root, as TypescriptAdapter passes it, even if process.cwd() differs from the project root', () => {
    const bunResolver = new BunImportResolver('typescript')
    const tsResolver = new TypescriptImportResolver('typescript')
    const chain = new ChainedImportResolver([bunResolver, tsResolver])

    const tsResolveSpy = spyOn(tsResolver, 'resolve')

    const result = chain.resolve(
      './does-not-exist',
      'app.ts',
      [],
      ImportKind.Default,
      EdgeKind.Import,
    )

    expect(result).not.toBeNull()
    expect(result?.resolvedKind).toBe(ResolvedKind.Unresolved)
    expect(result?.reason).toContain('No tsconfig.json found')
    expect(tsResolveSpy).toHaveBeenCalledTimes(1)
  })
})
