import { describe, it, expect, beforeAll, afterEach } from 'bun:test'
import { IndexerDB } from '../src/database/IndexerDB'
import {
  getStoreForTests,
  getAppStateManagerForTests,
} from '../scripts/test_setup'
import {
  resolveSymbol,
  resolveFile,
} from '../src/server/tools/helpers/symbolLookup'
import {
  parseParameters,
  formatParameters,
  formatInheritence,
  formatResolutionAnnotation,
  filePathToTopDir,
} from '../src/server/tools/helpers/format'
import { AppStateManager } from '../src/state'
import type { IndexerConfig } from '../src/config/types'
import { loadEmbedder } from '../src/server/tools/helpers/embedder'
import { OllamaEmbeddingGenerator } from '../src/indexer/embedders/OllamaEmbeddingGenerator'

const originalFetch = globalThis.fetch

describe('helpers/format', () => {
  it('parseParameters returns null when parameters_json is missing', () => {
    expect(parseParameters({ parameters_json: null })).toBeNull()
  })

  it('parseParameters returns null on malformed JSON', () => {
    expect(
      parseParameters({ parameters_json: 'this is not json {' }),
    ).toBeNull()
  })

  it('parseParameters parses valid JSON', () => {
    const params = parseParameters({
      parameters_json: JSON.stringify([
        { name: 'a', type: 'number' },
        { name: 'b', type: 'string', optional: true },
      ]),
    })
    expect(params).toEqual([
      { name: 'a', type: 'number' },
      { name: 'b', type: 'string', optional: true },
    ])
  })

  it('formatParameters returns "(none)" when no params', () => {
    expect(formatParameters({ parameters_json: null })).toBe('(none)')
    expect(formatParameters({ parameters_json: JSON.stringify([]) })).toBe(
      '(none)',
    )
  })

  it('formatParameters formats name:type and marks optional params', () => {
    expect(
      formatParameters({
        parameters_json: JSON.stringify([
          { name: 'a', type: 'number' },
          { name: 'b', type: undefined },
        ]),
      }),
    ).toBe('a: number, b: unknown')
    expect(
      formatParameters({
        parameters_json: JSON.stringify([
          { name: 'a', type: 'number', optional: true },
        ]),
      }),
    ).toBe('a?: number')
  })

  it('formatInheritence returns empty string when no inheritence', () => {
    expect(formatInheritence({ inheritence: null })).toBe('')
    expect(formatInheritence({ inheritence: [] })).toBe('')
  })

  it('formatInheritence formats by id and by imports_id', () => {
    const result = formatInheritence({
      inheritence: [
        {
          inheritence_type: 'extends',
          inherits_from_name: 'Base',
          inherits_from_id: 'abc',
          inherits_from_imports_id: null,
        },
        {
          inheritence_type: 'implements',
          inherits_from_name: 'Shape',
          inherits_from_id: null,
          inherits_from_imports_id: 42,
        },
      ] as any,
    })
    expect(result).toContain('extends Base (id=abc)')
    expect(result).toContain('implements Shape (imports_id=42)')
  })

  it('filePathToTopDir extracts top-level dir', () => {
    expect(filePathToTopDir('src/foo/bar.ts')).toBe('src')
    expect(filePathToTopDir('foo.ts')).toBe('(root)')
    expect(filePathToTopDir('a/b/c.ts', 2)).toBe('a/b')
  })

  it('formatResolutionAnnotation returns empty string when no resolution data', () => {
    expect(formatResolutionAnnotation({})).toBe('')
    expect(
      formatResolutionAnnotation({ confidence: null, resolutionSource: null }),
    ).toBe('')
  })

  it('formatResolutionAnnotation renders confidence and source together', () => {
    expect(
      formatResolutionAnnotation({
        confidence: 90,
        resolutionSource: 'typescript',
      }),
    ).toBe(' [resolution: typescript, confidence 90]')
  })

  it('formatResolutionAnnotation renders source only when confidence missing', () => {
    expect(
      formatResolutionAnnotation({
        confidence: null,
        resolutionSource: 'lsp_definition',
      }),
    ).toBe(' [resolution: lsp_definition]')
  })

  it('formatResolutionAnnotation flags zero confidence as unresolved by default', () => {
    expect(
      formatResolutionAnnotation({ confidence: 0, resolutionSource: null }),
    ).toBe(' [resolution: unresolved, confidence 0]')
  })

  it('formatResolutionAnnotation can disable unresolved flagging', () => {
    expect(
      formatResolutionAnnotation({
        confidence: 0,
        resolutionSource: null,
        unresolvedWhenNull: false,
      }),
    ).toBe(' [resolution: confidence 0]')
  })
})

describe('helpers/symbolLookup', () => {
  let store: IndexerDB

  beforeAll(() => {
    store = getStoreForTests()
  })

  it('resolveSymbol by symbol_id returns the symbol', async () => {
    const symbol = await store.symbols.search(
      'add',
      undefined,
      undefined,
      undefined,
      1,
    )
    expect(symbol.length).toBeGreaterThan(0)
    const result = await resolveSymbol(store, { symbol_id: symbol[0]!.id })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.symbol.name).toBe(symbol[0]!.name)
    }
  })

  it('resolveSymbol returns error for missing symbol_id', async () => {
    const result = await resolveSymbol(store, { symbol_id: 'does-not-exist' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(
        "Symbol with id 'does-not-exist' not found",
      )
    }
  })

  it('resolveSymbol by name + file_path', async () => {
    const result = await resolveSymbol(store, {
      name: 'add',
      file_path_or_name: 'math.ts',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.symbol.name).toBe('add')
    }
  })

  it('resolveSymbol returns error when symbol not found in file', async () => {
    const result = await resolveSymbol(store, {
      name: 'nonexistentSymbol',
      file_path_or_name: 'math.ts',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("Symbol 'nonexistentSymbol' not found")
    }
  })

  it('resolveSymbol returns error when neither symbol_id nor name+file provided', async () => {
    const result = await resolveSymbol(store, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Must provide either symbol_id or both')
    }
  })

  it('resolveSymbol returns file error when no file matches', async () => {
    const result = await resolveSymbol(store, {
      name: 'add',
      file_path_or_name: 'totally_missing_file.ts',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('No file found matching')
    }
  })

  it('resolveFile returns a file for a unique match', async () => {
    const result = await resolveFile(store, 'math.ts')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file.path).toContain('math.ts')
    }
  })

  it('resolveFile returns error when multiple files match', async () => {
    const result = await resolveFile(store, '.ts')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Multiple files found matching')
    }
  })
})

describe('helpers/embedder', () => {
  let appState: AppStateManager
  let originalConfig: IndexerConfig | undefined

  beforeAll(() => {
    appState = getAppStateManagerForTests()
    originalConfig = appState.getItem('config') as IndexerConfig
  })

  afterEach(() => {
    // Restore the shared global config to avoid corrupting other test files.
    appState.setItem('config', originalConfig)
    globalThis.fetch = originalFetch
  })

  it('loadEmbedder returns null when no config set', async () => {
    appState.deleteItem('config')
    const embedder = await loadEmbedder()
    expect(embedder).toBeNull()
  })

  it('loadEmbedder returns null when embedder disabled', async () => {
    const config: IndexerConfig = {
      ...originalConfig!,
      embedder: { enabled: false, provider: 'ollama' },
    }
    appState.setItem('config', config)
    const embedder = await loadEmbedder()
    expect(embedder).toBeNull()
  })

  it('loadEmbedder returns null for unknown provider', async () => {
    const config: IndexerConfig = {
      ...originalConfig!,
      embedder: { enabled: true, provider: 'unknown-provider' as any },
    }
    appState.setItem('config', config)
    const embedder = await loadEmbedder()
    expect(embedder).toBeNull()
  })

  it('loadEmbedder returns null when provider init fails', async () => {
    const config: IndexerConfig = {
      ...originalConfig!,
      embedder: { enabled: true, provider: 'ollama' },
    }
    appState.setItem('config', config)

    globalThis.fetch = (async () => {
      return new Response('bad', { status: 500 })
    }) as any
    const embedder = await loadEmbedder()
    expect(embedder).toBeNull()
  })

  it('loadEmbedder returns an initialized generator on success', async () => {
    const config: IndexerConfig = {
      ...originalConfig!,
      embedder: {
        enabled: true,
        provider: 'ollama',
        ollama: { base_url: 'http://localhost:1', model: 'test-model' },
      },
    }
    appState.setItem('config', config)

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
        status: 200,
      })
    }) as any
    const embedder = await loadEmbedder()
    expect(embedder).toBeInstanceOf(OllamaEmbeddingGenerator)
  })
})

describe('AppStateManager', () => {
  let appState: AppStateManager
  // Save the full state so we can restore it after tests (state is shared globally).
  let originalState: Record<string, unknown> = {}

  beforeAll(() => {
    appState = AppStateManager.getInstance()
    originalState = { ...appState.getState() } as Record<string, unknown>
  })

  afterEach(() => {
    // Restore all keys rather than disposing, to avoid clobbering global state
    // that other test files rely on (e.g. root, config).
    const state = appState.getState() as Record<string, unknown>
    for (const key of Object.keys(state)) {
      delete state[key]
    }
    Object.assign(state, originalState)
  })

  it('returns the same singleton instance', () => {
    expect(AppStateManager.getInstance()).toBe(appState)
  })

  it('setItem/getItem roundtrips a value', () => {
    appState.setItem('root', '/tmp/root')
    expect(appState.getItem('root')).toBe('/tmp/root')
  })

  it('getItem returns undefined for missing key', () => {
    expect(appState.getItem('nonexistent' as any)).toBeUndefined()
  })

  it('updateItem merges into existing object state', () => {
    const base = { ...(originalState as any).config } as IndexerConfig
    appState.setItem('config', base)
    appState.updateItem('config', { enabled: false })
    const updated = appState.getItem('config') as IndexerConfig
    expect(updated.enabled).toBe(false)
  })

  it('updateItem throws when key does not exist', () => {
    appState.deleteItem('watcher' as any)
    expect(() => appState.updateItem('watcher', {} as any)).toThrow(
      'Cannot update non-existent key',
    )
  })

  it('deleteItem removes the key', () => {
    appState.setItem('root', '/tmp/root')
    appState.deleteItem('root')
    expect(appState.getItem('root')).toBeUndefined()
  })
})
