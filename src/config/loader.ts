import { default_config } from './default_config'
import { join } from 'node:path'
import type { IndexerConfig } from './types'
import { existsSync } from 'node:fs'
import { logError, logWarning } from 'src/utils/logger'
export const AGENTIC_DIR = import.meta.env.AGENTIC_DIR || '.agentic'
export const CONFIG_FILENAME = import.meta.env.CONFIG_FILENAME || 'config.json'

export const DEFAULT_CONFIG = default_config

/** Loads and merges indexer configuration from the specified root directory, returning default settings if the configuration file is missing or invalid. */
export async function loadConfig(rootDir: string): Promise<IndexerConfig> {
  const configPath = join(rootDir, AGENTIC_DIR, CONFIG_FILENAME)

  if (!existsSync(configPath)) {
    logWarning(`Config file not found at ${configPath}, using default config.`)
    return DEFAULT_CONFIG.indexer
  }

  try {
    const configContent = await Bun.file(configPath).text()
    const userConfig = JSON.parse(configContent) as {
      indexer?: Partial<IndexerConfig>
    }
    return {
      ...DEFAULT_CONFIG.indexer,
      ...userConfig.indexer,
      languages: {
        ...DEFAULT_CONFIG.indexer.languages,
        ...userConfig.indexer?.languages,
      },
      docstring_generation: {
        enabled:
          userConfig.indexer?.docstring_generation?.enabled ??
          DEFAULT_CONFIG.indexer.docstring_generation!.enabled,
        provider:
          userConfig.indexer?.docstring_generation?.provider ??
          DEFAULT_CONFIG.indexer.docstring_generation!.provider,
        write_to_file:
          userConfig.indexer?.docstring_generation?.write_to_file ??
          DEFAULT_CONFIG.indexer.docstring_generation!.write_to_file,
        ...(userConfig.indexer?.docstring_generation?.claude && {
          claude: userConfig.indexer.docstring_generation.claude,
        }),
        ...(userConfig.indexer?.docstring_generation?.gemini && {
          gemini: userConfig.indexer.docstring_generation.gemini,
        }),
        ...(userConfig.indexer?.docstring_generation?.openai && {
          openai: userConfig.indexer.docstring_generation.openai,
        }),
        ...(userConfig.indexer?.docstring_generation?.ollama && {
          ollama: userConfig.indexer.docstring_generation.ollama,
        }),
      },
    }
  } catch (err) {
    logError(
      `Failed to load config file at ${configPath}, using default config.`,
    )
    logError('', err)
    return DEFAULT_CONFIG.indexer
  }
}
