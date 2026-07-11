import { default_config } from './default_config'
import { join } from 'node:path'
import type { IndexerConfig, LanguageConfig } from './types'
import { existsSync } from 'node:fs'
import { logError, logInfo, logWarning } from 'src/utils/logger'
import type { SupportedLanguage } from 'tree-sitter-wasm'

/** Load the configuration for the indexer by checking the specified directory and files. If a valid configuration file is found, use its settings; otherwise, default values are applied, with special attention to docstring generation preferences. */
export async function loadConfig(rootDir: string): Promise<IndexerConfig> {
  const AGENTIC_DIR = process.env.AGENTIC_DIR || '.agentic'
  const CONFIG_FILENAME = process.env.CONFIG_FILENAME || 'config.json'

  const configPath = join(rootDir, AGENTIC_DIR, CONFIG_FILENAME)

  if (!existsSync(configPath)) {
    logWarning(`Config file not found at ${configPath}, using default config.`)
    return {
      ...default_config.indexer,
      extnToLangMap: populateExtnToLangMap(default_config.indexer.languages),
    }
  }

  try {
    const configContent = await Bun.file(configPath).text()
    const userConfig = JSON.parse(configContent) as {
      indexer?: Partial<IndexerConfig>
    }
    const config: IndexerConfig = {
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

    config.extnToLangMap = populateExtnToLangMap(config.languages)

    return config
  } catch (err) {
    logError(
      `Failed to load config file at ${configPath}, using default config.`,
    )
    logError('', err)
    const defaultConfig = default_config.indexer
    defaultConfig.extnToLangMap = populateExtnToLangMap(defaultConfig.languages)
    return defaultConfig
  }
}

/** Save the indexer configuration to a JSON file in the specified project root directory. The configuration is stored in the `.agentic` directory as `config.json`. If the config file already exists, the function skips creation and logs a warning. */
export async function saveConfig(
  rootDir: string,
  config: IndexerConfig,
): Promise<void> {
  const AGENTIC_DIR = process.env.AGENTIC_DIR || '.agentic'
  const CONFIG_FILENAME = process.env.CONFIG_FILENAME || 'config.json'

  const configPath = join(rootDir, AGENTIC_DIR, CONFIG_FILENAME)

  if (existsSync(configPath)) {
    logWarning(`Config file already exists at ${configPath}, skipping.`)
    return
  }

  try {
    await Bun.write(configPath, JSON.stringify({ indexer: config }, null, 2))
    logInfo(`Config saved to ${configPath}`)
  } catch (err) {
    logError(`Failed to save config file at ${configPath}.`, err)
  }
}

/** Populates a mapping of file extensions to supported programming languages based on the given language configurations. This map allows quick lookup of which language corresponds to specific file extensions. */
function populateExtnToLangMap(
  languages: Record<string, LanguageConfig>,
): Record<string, SupportedLanguage> {
  const extnToLangMap: Record<string, SupportedLanguage> = {}
  for (const [lang, config] of Object.entries(languages)) {
    if (!config.enabled) continue
    const cleanedExtensions = config.extensions.map((ext) =>
      ext.startsWith('.') ? ext.slice(1) : ext,
    )
    for (const ext of cleanedExtensions) {
      extnToLangMap[ext] = lang as SupportedLanguage
    }
  }
  return extnToLangMap
}
