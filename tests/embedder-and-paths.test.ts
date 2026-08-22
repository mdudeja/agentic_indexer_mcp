import { describe, it, expect, beforeAll, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppStateManager } from '../src/state'
import { OllamaEmbeddingGenerator } from '../src/indexer/embedders/OllamaEmbeddingGenerator'
import {
  resolvePath,
  resolveImportedModulePath,
  resolveWorkspacePath,
  isPathLike,
} from '../src/utils/paths'
import { getAppStateManagerForTests } from '../scripts/test_setup'

describe('OllamaEmbeddingGenerator', () => {
  let appState: AppStateManager
  let originalConfig: any
  const originalFetch = globalThis.fetch

  beforeAll(() => {
    appState = getAppStateManagerForTests()
    originalConfig = appState.getItem('config')
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    // Restore the shared global config so other test files are unaffected.
    appState.setItem('config', originalConfig)
  })

  it('getEmbedding returns null when config is missing', async () => {
    appState.deleteItem('config')
    const gen = new OllamaEmbeddingGenerator()
    const result = await gen.getEmbedding('hello')
    expect(result).toBeNull()
  })

  it('getEmbedding returns null when embedder is disabled', async () => {
    appState.setItem('config', {
      embedder: { enabled: false, provider: 'ollama' },
    } as any)
    const gen = new OllamaEmbeddingGenerator()
    const result = await gen.getEmbedding('hello')
    expect(result).toBeNull()
  })

  it('getEmbedding returns null when ollama config is missing', async () => {
    appState.setItem('config', {
      embedder: { enabled: true, provider: 'ollama' },
    } as any)
    const gen = new OllamaEmbeddingGenerator()
    const result = await gen.getEmbedding('hello')
    expect(result).toBeNull()
  })

  it('getEmbedding returns embedding vector on success', async () => {
    appState.setItem('config', {
      embedder: {
        enabled: true,
        provider: 'ollama',
        ollama: { base_url: 'http://localhost:1', model: 'nomic-embed-text' },
      },
    } as any)
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
        status: 200,
      })
    }) as any
    const gen = new OllamaEmbeddingGenerator()
    const result = await gen.getEmbedding('hello')
    expect(result).toEqual([0.1, 0.2, 0.3])
  })

  it('getEmbedding returns null on non-OK response', async () => {
    appState.setItem('config', {
      embedder: {
        enabled: true,
        provider: 'ollama',
        ollama: { base_url: 'http://localhost:1', model: 'm' },
      },
    } as any)
    globalThis.fetch = (async () => {
      return new Response('error', { status: 500 })
    }) as any
    const gen = new OllamaEmbeddingGenerator()
    const result = await gen.getEmbedding('hello')
    expect(result).toBeNull()
  })

  it('getEmbedding returns null on invalid response format', async () => {
    appState.setItem('config', {
      embedder: {
        enabled: true,
        provider: 'ollama',
        ollama: { base_url: 'http://localhost:1', model: 'm' },
      },
    } as any)
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ foo: 'bar' }), { status: 200 })
    }) as any
    const gen = new OllamaEmbeddingGenerator()
    const result = await gen.getEmbedding('hello')
    expect(result).toBeNull()
  })

  it('getEmbedding returns null when fetch throws', async () => {
    appState.setItem('config', {
      embedder: {
        enabled: true,
        provider: 'ollama',
        ollama: { base_url: 'http://localhost:1', model: 'm' },
      },
    } as any)
    globalThis.fetch = (async () => {
      throw new Error('connection refused')
    }) as any
    const gen = new OllamaEmbeddingGenerator()
    const result = await gen.getEmbedding('hello')
    expect(result).toBeNull()
  })

  it('init returns true when embedding generation works', async () => {
    appState.setItem('config', {
      embedder: {
        enabled: true,
        provider: 'ollama',
        ollama: { base_url: 'http://localhost:1', model: 'm' },
      },
    } as any)
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 })
    }) as any
    const gen = new OllamaEmbeddingGenerator()
    const ok = await gen.init()
    expect(ok).toBe(true)
  })

  it('init returns false when embedding generation fails', async () => {
    appState.setItem('config', {
      embedder: {
        enabled: true,
        provider: 'ollama',
        ollama: { base_url: 'http://localhost:1', model: 'm' },
      },
    } as any)
    globalThis.fetch = (async () => {
      return new Response('err', { status: 500 })
    }) as any
    const gen = new OllamaEmbeddingGenerator()
    const ok = await gen.init()
    expect(ok).toBe(false)
  })
})

describe('paths utils', () => {
  let appState: AppStateManager
  let tempDir: string
  let originalRoot: string | undefined

  beforeAll(() => {
    appState = getAppStateManagerForTests()
    originalRoot = appState.getItem('root') as string | undefined
  })

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
    // Restore the shared root so other test files are unaffected.
    appState.setItem('root', originalRoot)
  })

  it('resolvePath resolves tilde paths to home dir', () => {
    const result = resolvePath('~/some/file.ts')
    expect(result.startsWith('/home')).toBe(true)
    expect(result).toContain('some/file.ts')
  })

  it('resolvePath returns absolute paths unchanged', () => {
    expect(resolvePath('/abs/path.ts')).toBe('/abs/path.ts')
  })

  it('resolvePath uses fromDir when provided', () => {
    const result = resolvePath('file.ts', '/base/dir')
    expect(result).toBe('/base/dir/file.ts')
  })

  it('resolvePath falls back to app root', () => {
    appState.setItem('root', '/my/root')
    const result = resolvePath('file.ts')
    expect(result).toBe('/my/root/file.ts')
    appState.deleteItem('root')
  })

  it('isPathLike detects forward slashes', () => {
    expect(isPathLike('a/b.ts')).toBe(true)
    expect(isPathLike('a\\b.ts')).toBe(true)
    expect(isPathLike('file.ts')).toBe(false)
  })

  it('resolveWorkspacePath resolves a path inside root', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-paths-'))
    appState.setItem('root', tempDir)
    const abs = resolveWorkspacePath('src/file.ts')
    expect(abs).toBe(join(tempDir, 'src', 'file.ts'))
    appState.deleteItem('root')
  })

  it('resolveWorkspacePath throws when root not set', () => {
    appState.deleteItem('root')
    expect(() => resolveWorkspacePath('x.ts')).toThrow(
      'Root directory is not set',
    )
  })

  it('resolveWorkspacePath throws when path escapes root', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-paths-'))
    appState.setItem('root', tempDir)
    expect(() => resolveWorkspacePath('../escape.ts')).toThrow(
      'outside the workspace root',
    )
    appState.deleteItem('root')
  })

  it('resolveImportedModulePath resolves relative directory import', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-paths-'))
    mkdirSync(join(tempDir, 'src', 'dir'), { recursive: true })
    appState.setItem('root', tempDir)
    const result = resolveImportedModulePath(
      './dir',
      'src/file.ts',
      '.ts',
      'index.ts',
    )
    expect(result).toBe('src/dir/index.ts')
    appState.deleteItem('root')
  })

  it('resolveImportedModulePath appends extension for relative file', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-paths-'))
    appState.setItem('root', tempDir)
    const result = resolveImportedModulePath(
      './lib',
      'src/file.ts',
      '.ts',
      'index.ts',
    )
    expect(result).toBe('src/lib.ts')
    appState.deleteItem('root')
  })

  it('resolveImportedModulePath returns importPath when non-relative resolve fails', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-paths-'))
    appState.setItem('root', tempDir)
    const result = resolveImportedModulePath(
      'some/random/pkg',
      'src/file.ts',
      '.ts',
      'index.ts',
    )
    expect(result).toBe('some/random/pkg')
    appState.deleteItem('root')
  })
})
