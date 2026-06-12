import type { DocstringConfig } from 'src/config/types'
import { logWarning } from 'src/utils/logger'
import { ClaudeProvider } from './providers/ClaudeProvider'
import type { DocstringProvider } from './providers/DocStringProvider'
import { GeminiProvider } from './providers/GeminiProvider'
import { OllamaProvider } from './providers/OllamaProvider'
import { OpenAIProvider } from './providers/OpenAIProvider'

/** Creates a docstring provider based on the configuration settings. If the required configuration for the selected provider is missing, it returns null after logging a warning. */
export function createProvider(
  config: DocstringConfig,
): DocstringProvider | null {
  switch (config.provider) {
    case 'claude':
      if (!config.claude?.api_key) {
        logWarning(
          '[DocstringProvider] claude selected but no claude.api_key in config',
        )
        return null
      }
      return new ClaudeProvider(config.claude)
    case 'gemini':
      if (!config.gemini?.api_key) {
        logWarning(
          '[DocstringProvider] gemini selected but no gemini.api_key in config',
        )
        return null
      }
      return new GeminiProvider(config.gemini)
    case 'openai':
      if (!config.openai?.api_key) {
        logWarning(
          '[DocstringProvider] openai selected but no openai.api_key in config',
        )
        return null
      }
      return new OpenAIProvider(config.openai)
    case 'ollama':
      if (!config.ollama?.model) {
        logWarning(
          '[DocstringProvider] ollama selected but no ollama.model in config',
        )
        return null
      }
      return new OllamaProvider(config.ollama.model, config.ollama.base_url)
  }
}
