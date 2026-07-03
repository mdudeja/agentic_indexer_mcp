import { default_config } from './default_config'
import { join } from 'node:path'
import type { IndexerConfig } from './types'
import { existsSync } from 'node:fs'
import { logError, logWarning } from 'src/utils/logger'

/** Load the configuration for the indexer by checking the specified directory and files. If a valid configuration file is found, use its settings; otherwise, default values are applied, with special attention to docstring generation preferences. */
export async function loadConfig(rootDir: string): Promise<IndexerConfig> {
  const AGENTIC_DIR = process.env.AGENTIC_DIR || '.agentic'
  const CONFIG_FILENAME = process.env.CONFIG_FILENAME || 'config.json'

  const configPath = join(rootDir, AGENTIC_DIR, CONFIG_FILENAME)

  if (!existsSync(configPath)) {
    logWarning(`Config file not found at ${configPath}, using default config.`)
    return default_config.indexer
  }

  try {
    const configContent = await Bun.file(configPath).text()
    const userConfig = JSON.parse(configContent) as {
      indexer?: Partial<IndexerConfig>
    }
    return {
      ...default_config.indexer,
      ...userConfig.indexer,
      languages: {
        ...default_config.indexer.languages,
        ...userConfig.indexer?.languages,
      },
      docstring_generation: {
        enabled:
          userConfig.indexer?.docstring_generation?.enabled ??
          default_config.indexer.docstring_generation!.enabled,
        provider:
          userConfig.indexer?.docstring_generation?.provider ??
          default_config.indexer.docstring_generation!.provider,
        write_to_file:
          userConfig.indexer?.docstring_generation?.write_to_file ??
          default_config.indexer.docstring_generation!.write_to_file,
        exclude_generation_patterns:
          userConfig.indexer?.docstring_generation
            ?.exclude_generation_patterns ??
          default_config.indexer.docstring_generation!
            .exclude_generation_patterns,
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
    return default_config.indexer
  }
}
