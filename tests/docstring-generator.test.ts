import { describe, it, expect, beforeAll, afterEach } from 'bun:test'
import { IndexerDB } from '../src/database/IndexerDB'
import {
  getStoreForTests,
  getAppStateManagerForTests,
} from '../scripts/test_setup'
import { DocstringGenerationStep } from '../src/indexer/steps/s3_docstring_generator'
import { SymbolKind } from '../src/database/schemas'
import type { IndexerConfig } from '../src/config/types'

describe('DocstringGenerationStep', () => {
  let store: IndexerDB
  let appState: ReturnType<typeof getAppStateManagerForTests>
  const originalFetch = globalThis.fetch
  let originalConfig: IndexerConfig | undefined

  beforeAll(async () => {
    store = getStoreForTests()
    appState = getAppStateManagerForTests()
    originalConfig = appState.getItem('config') as IndexerConfig
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    // Restore the original config so other test files are unaffected.
    appState.setItem('config', originalConfig)
  })

  /** Returns a config with docstring generation enabled using the mock provider. */
  function enableDocstringConfig(writeToFile = false): IndexerConfig {
    const config = {
      ...originalConfig!,
      docstring_generation: {
        enabled: true,
        provider: 'ollama' as const,
        write_to_file: writeToFile,
        exclude_generation_patterns: [],
        ollama: { model: 'mock', base_url: 'http://localhost:1' },
      },
    }
    appState.setItem('config', config as IndexerConfig)
    return config as IndexerConfig
  }

  it('run returns early when docstring_generation is not enabled', async () => {
    appState.setItem('config', originalConfig!)
    const step = new DocstringGenerationStep('/workspace')
    // Should not throw and should simply return.
    await expect(step.run(store)).resolves.toBeUndefined()
  })

  it('run generates docstrings for symbols needing them', async () => {
    enableDocstringConfig(false)

    // Find a symbol currently lacking a docstring.
    const needing = await store.symbols.getSymbolsNeedingDocstrings([
      SymbolKind.function,
    ])
    expect(needing.length).toBeGreaterThan(0)
    const target = needing[0]!
    const originalDocstring = target.docstring

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ response: 'A generated docstring' }),
        {
          status: 200,
        },
      )
    }) as any

    const fixtureDir = process.env.IDXR_TEST_FIXTURES_DIR as string
    const step = new DocstringGenerationStep(`${process.cwd()}/${fixtureDir}`)

    await step.run(store)

    const updated = await store.symbols.getDefinition(target.id)
    expect(updated).toBeDefined()
    expect(updated?.docstring).toBeTruthy()
    // Clean up: restore original docstring so other tests stay deterministic.
    if (updated) {
      await store.symbols.updateDocstring(target.id, originalDocstring ?? '')
    }
  })

  it('runOnOneFile skips excluded files', async () => {
    const config = {
      ...originalConfig!,
      docstring_generation: {
        enabled: true,
        provider: 'ollama' as const,
        write_to_file: false,
        exclude_generation_patterns: ['**/node_modules/**'],
        ollama: { model: 'mock', base_url: 'http://localhost:1' },
      },
    }
    appState.setItem('config', config as IndexerConfig)
    const step = new DocstringGenerationStep(
      `${process.cwd()}/${process.env.IDXR_TEST_FIXTURES_DIR}`,
    )
    await expect(
      step.runOnOneFile('node_modules/excluded.ts', store),
    ).resolves.toBeUndefined()
  })

  it('runOnOneFile handles files with no symbols needing docstrings', async () => {
    enableDocstringConfig(false)
    const step = new DocstringGenerationStep(
      `${process.cwd()}/${process.env.IDXR_TEST_FIXTURES_DIR}`,
    )
    await expect(step.runOnOneFile('car.txt', store)).resolves.toBeUndefined()
  })

  it('runOnOneFile returns early when docstring generation disabled', async () => {
    appState.setItem('config', originalConfig!)
    const step = new DocstringGenerationStep(
      `${process.cwd()}/${process.env.IDXR_TEST_FIXTURES_DIR}`,
    )
    await expect(step.runOnOneFile('math.ts', store)).resolves.toBeUndefined()
  })

  it('removeAllDocstrings removes docstrings from the database', async () => {
    enableDocstringConfig(false)

    // Pick an existing symbol and give it a docstring without re-indexing the file.
    const existing = await store.symbols.getSymbolsNeedingDocstrings([
      SymbolKind.function,
    ])
    expect(existing.length).toBeGreaterThan(0)
    const target = existing[0]!
    await store.symbols.updateDocstring(target.id, 'Existing docstring')

    const step = new DocstringGenerationStep(
      `${process.cwd()}/${process.env.IDXR_TEST_FIXTURES_DIR}`,
    )
    await step.removeAllDocstrings(store)

    const after = await store.symbols.getDefinition(target.id)
    expect(after).toBeDefined()
    expect(after?.docstring).toBeFalsy()
  })

  it('removeAllDocstrings returns early when no docstrings exist', async () => {
    enableDocstringConfig(false)
    // Use a target kind with no symbols having docstrings by deleting all docstrings first.
    const step = new DocstringGenerationStep(
      `${process.cwd()}/${process.env.IDXR_TEST_FIXTURES_DIR}`,
    )
    await expect(step.removeAllDocstrings(store)).resolves.toBeUndefined()
  })
})
