import { default_config } from './default_config'
import { join } from 'node:path'
import type { IndexerConfig } from './types'
import { existsSync } from 'node:fs'
import { logError, logWarning } from 'src/utils/logger'
export const AGENTIC_DIR = import.meta.env.AGENTIC_DIR || '.agentic'
export const CONFIG_FILENAME = import.meta.env.CONFIG_FILENAME || 'config.json'

export const DEFAULT_CONFIG = default_config

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
    }
  } catch (err) {
    logError(
      `Failed to load config file at ${configPath}, using default config.`,
    )
    logError('', err)
    return DEFAULT_CONFIG.indexer
  }
}
