import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'path'
import { FileManager } from '../src/indexer/FileManager'
import type { IndexerConfig } from 'src/config/types'
import { getAppStateManagerForTests } from '../scripts/test_setup'

let ROOT: string
let originalConfig: IndexerConfig | undefined
let originalIncludeGitIgnored: boolean | undefined

/** Tears down the FileManager singleton and rebuilds it against the shared root with the given config, so each test gets an isolated set of ignore globs. */
async function createFileManager(
  opts: {
    ignore_patterns?: string[]
    includeGitIgnored?: boolean
  } = {},
): Promise<FileManager> {
  const appStateManager = getAppStateManagerForTests()
  originalConfig = appStateManager.getItem('config')
  originalIncludeGitIgnored = appStateManager.getItem('includeGitIgnored')

  if (!originalConfig) {
    throw new Error('Expected config to be set by scripts/test_setup preload')
  }

  const config: IndexerConfig = {
    ...originalConfig,
    ignore_patterns: opts.ignore_patterns ?? [],
  }
  appStateManager.setItem('config', config)
  appStateManager.setItem('includeGitIgnored', opts.includeGitIgnored ?? false)
  return FileManager.getInstance()
}

describe('FileManager', () => {
  beforeAll(() => {
    const appStateManager = getAppStateManagerForTests()
    const root = appStateManager.getItem('root')
    if (!root) {
      throw new Error('Expected root to be set by scripts/test_setup preload')
    }
    ROOT = root
    originalConfig = appStateManager.getItem('config')
    originalIncludeGitIgnored = appStateManager.getItem('includeGitIgnored')
  })

  afterAll(async () => {
    const appStateManager = getAppStateManagerForTests()
    if (originalConfig) {
      appStateManager.setItem('config', originalConfig)
    }
    appStateManager.setItem(
      'includeGitIgnored',
      originalIncludeGitIgnored ?? false,
    )

    const fm = await createFileManager()
    fm.reset()
  })

  test('recursively discovers every .gitignore file under the root', async () => {
    const fm = await createFileManager()
    const files = await fm.findGitignoreFiles(ROOT)
    const relFiles = files.map((f) => f.slice(ROOT.length + 1))

    expect(relFiles).toContain('.gitignore')
    expect(relFiles).toContain(join('subproj', '.gitignore'))
    expect(relFiles).toContain(join('assets', '.gitignore'))
    expect(relFiles).toContain(join('commentsonly', '.gitignore'))
    expect(relFiles).toContain(join('skipped', '.gitignore'))
  })

  test('ignores a literal file name', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored('debug.log')).toBe(true)
  })

  test('does not ignore a file that matches no pattern', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored('keep.txt')).toBe(false)
  })

  test('a bare directory name ignores its contents at any depth', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored(join('node_modules', 'pkg', 'index.txt'))).toBe(
      true,
    )
  })

  test('a trailing-slash directory pattern ignores its contents', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored(join('dist', 'bundle.txt'))).toBe(true)
  })

  test('* extension wildcard ignores every matching file', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored('other.log')).toBe(true)
    expect(fm.isPathIgnored('debug.log')).toBe(true)
  })

  test('? matches exactly one character', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored('car.txt')).toBe(true)
    expect(fm.isPathIgnored('cat.txt')).toBe(true)
    expect(fm.isPathIgnored('cats.txt')).toBe(false)
  })

  test('a [0-9] character class matches only the specified range', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored('file1.txt')).toBe(true)
    expect(fm.isPathIgnored('file2.txt')).toBe(true)
    expect(fm.isPathIgnored('file9.txt')).toBe(true)
    expect(fm.isPathIgnored('filea.txt')).toBe(false)
  })

  test('a leading **/ pattern matches files at any depth', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored(join('cache', 'data.cache'))).toBe(true)
    expect(fm.isPathIgnored(join('deep', 'nested', 'file.cache'))).toBe(true)
  })

  test('a {a,b} brace-expansion pattern from a nested .gitignore matches any alternative', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored(join('assets', 'image.png'))).toBe(true)
    expect(fm.isPathIgnored(join('assets', 'photo.jpg'))).toBe(true)
    expect(fm.isPathIgnored(join('assets', 'data.txt'))).toBe(false)
  })

  test('a negated pattern re-includes a specific file inside an ignored directory', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored(join('logs', 'keep.log'))).toBe(false)
    expect(fm.isPathIgnored(join('logs', 'other.log'))).toBe(true)
  })

  test('a negated pattern re-includes a file otherwise matched by an extension wildcard', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored('important.log')).toBe(false)
  })

  test('a leading-slash pattern only ignores the root-level match, not nested matches of the same name', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored(join('build', 'output.txt'))).toBe(true)
    expect(fm.isPathIgnored(join('deep', 'nested', 'build', 'inner.txt'))).toBe(
      false,
    )
  })

  test('comments and blank lines are ignored without affecting matching', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored(join('commentsonly', 'file.txt'))).toBe(false)
  })

  test('a literal pattern in a nested .gitignore ignores matching files within that subtree', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored(join('subproj', 'temp.tmp'))).toBe(true)
    expect(fm.isPathIgnored(join('subproj', 'main.txt'))).toBe(false)
  })

  test('a .gitignore file itself ignored by an earlier pattern is not parsed for further patterns', async () => {
    const fmOrig = await FileManager.getInstance()
    fmOrig.reset()

    const fm = await createFileManager({ ignore_patterns: ['skipped'] })
    const globs = fm.getIgnoreGlobs()
    expect(Array.from(globs.keys())).not.toContain('**/shouldnotapply.txt')
    expect(fm.isPathIgnored(join('skipped', 'other.txt'))).toBe(true)
    expect(fm.isPathIgnored(join('skipped', 'shouldnotapply.txt'))).toBe(true)

    fm.reset()
  })

  test('trims unescaped trailing whitespace from a pattern line', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored('spaced.txt')).toBe(true)
  })

  test('preserves a backslash-escaped trailing space in a pattern', async () => {
    const fm = await createFileManager()
    expect(fm.isPathIgnored('keepme ')).toBe(true)
  })

  test('patterns from config are applied the same way as .gitignore patterns', async () => {
    const fmOrig = await FileManager.getInstance()
    fmOrig.reset()

    const fm = await createFileManager({ ignore_patterns: ['*.spec.txt'] })
    expect(fm.isPathIgnored('spec-file.spec.txt')).toBe(true)
    expect(fm.isPathIgnored('keep.txt')).toBe(false)

    fm.reset()
  })

  test('skips reading .gitignore files entirely while still applying config ignore_patterns', async () => {
    const fmOrig = await FileManager.getInstance()
    fmOrig.reset()

    const fm = await createFileManager({
      ignore_patterns: ['*.spec.txt'],
      includeGitIgnored: true,
    })
    expect(fm.isPathIgnored('debug.log')).toBe(false)
    expect(fm.isPathIgnored('spec-file.spec.txt')).toBe(true)

    fm.reset()
  })

  test('produces the same result for absolute and root-relative paths', async () => {
    const fm = await createFileManager()
    const abs = join(ROOT, 'debug.log')
    expect(fm.isPathIgnored(abs)).toBe(true)
    expect(fm.isPathIgnored(abs)).toBe(fm.isPathIgnored('debug.log'))
  })
})
