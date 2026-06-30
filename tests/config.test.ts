import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config/loader'
import { default_config } from '../src/config/default_config'

let tempDirs: string[] = []

/** Creates a unique temporary directory for configuration testing purposes. The function generates a new directory each time its called, ensuring uniqueness by using a specific naming convention. It also tracks the created directories for potential cleanup. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-cfg-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('loadConfig', () => {
  it('returns default config when config file does not exist', async () => {
    const rootDir = makeTempDir()
    const config = await loadConfig(rootDir)
    expect(config).toEqual(default_config.indexer)
  })

  it('returns default config when agentic dir is missing', async () => {
    const rootDir = makeTempDir()
    const config = await loadConfig(rootDir)
    expect(config.languages).toBeDefined()
    expect(config.docstring_generation).toBeDefined()
  })

  it('merges user config with defaults', async () => {
    const rootDir = makeTempDir()
    const agenticDir = join(rootDir, '.agentic')
    mkdirSync(agenticDir)
    const userConfig = {
      indexer: {
        docstring_generation: {
          enabled: true,
          provider: 'ollama' as const,
          write_to_file: false,
        },
      },
    }
    writeFileSync(join(agenticDir, 'config.json'), JSON.stringify(userConfig))

    const config = await loadConfig(rootDir)
    expect(config.docstring_generation?.enabled).toBe(true)
    expect(config.docstring_generation?.provider).toBe('ollama')
    expect(config.docstring_generation?.write_to_file).toBe(false)
    expect(config.languages).toEqual(default_config.indexer.languages)
  })

  it('returns default config when config file contains invalid JSON', async () => {
    const rootDir = makeTempDir()
    const agenticDir = join(rootDir, '.agentic')
    mkdirSync(agenticDir)
    writeFileSync(join(agenticDir, 'config.json'), '{ invalid json }')

    const config = await loadConfig(rootDir)
    expect(config).toEqual(default_config.indexer)
  })

  it('merges provider-specific docstring config when present', async () => {
    const rootDir = makeTempDir()
    const agenticDir = join(rootDir, '.agentic')
    mkdirSync(agenticDir)
    const userConfig = {
      indexer: {
        docstring_generation: {
          enabled: true,
          provider: 'claude' as const,
          write_to_file: true,
          claude: { model: 'claude-sonnet-4-6', max_tokens: 512 },
        },
      },
    }
    writeFileSync(join(agenticDir, 'config.json'), JSON.stringify(userConfig))

    const config = await loadConfig(rootDir)
    expect((config.docstring_generation as any)?.claude?.model).toBe(
      'claude-sonnet-4-6',
    )
    expect((config.docstring_generation as any)?.claude?.max_tokens).toBe(512)
  })

  it('uses default docstring_generation values when provider config omits fields', async () => {
    const rootDir = makeTempDir()
    const agenticDir = join(rootDir, '.agentic')
    mkdirSync(agenticDir)
    const userConfig = { indexer: {} }
    writeFileSync(join(agenticDir, 'config.json'), JSON.stringify(userConfig))

    const config = await loadConfig(rootDir)
    expect(config.docstring_generation?.enabled).toBe(
      default_config.indexer.docstring_generation!.enabled,
    )
    expect(config.docstring_generation?.provider).toBe(
      default_config.indexer.docstring_generation!.provider,
    )
  })
})
