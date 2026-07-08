/** This module defines TypeScript type definitions for configuring and working with an indexer or similar tool. It includes types related to language configurations, docstring strategies, embedding generation, and indexers themselves. The module provides a structured way to define how code is processed, documented, and analyzed, supporting multiple language providers and integration with various AI-based tools like Claude, Gemini, OpenAI, and more. */
export type {
  IndexedFile,
  IndexedSymbol,
  IndexedImport,
  IndexedSymbolCall,
  IndexedException,
  IndexedEnvVar,
} from '../database/schemas'
export { SymbolKind } from '../database/schemas'

import type { SupportedLanguage } from 'tree-sitter-wasm'

export type LanguageConfig = {
  extensions: string[]
  lsp_command?: string[]
  lang_features_paths?: string[]
  treesitter: {
    language_name: string
    signature_max_length?: number
  }
}

type DocstringProviderName = 'claude' | 'gemini' | 'openai' | 'ollama'

export type DocstringConfig = {
  enabled: boolean
  provider: DocstringProviderName
  write_to_file: boolean
  exclude_generation_patterns: string[]
  claude?: { api_key: string; model?: string }
  gemini?: { api_key: string; model?: string }
  openai?: { api_key: string; model?: string }
  ollama?: { model: string; base_url?: string }
}

type EmbeddingGeneratorName = 'ollama' | 'openai' | 'gemini' | 'anthropic'

export type EmbedderConfig = {
  enabled: boolean
  provider: EmbeddingGeneratorName
  ollama?: { model?: string; base_url?: string; api_key?: string }
  openai?: { model?: string; base_url?: string; api_key?: string }
  gemini?: { model?: string; base_url?: string; api_key?: string }
  anthropic?: { model?: string; base_url?: string; api_key?: string }
}

export type IndexerConfig = {
  enabled: boolean
  ignore_patterns: string[]
  extnToLangMap: Record<string, SupportedLanguage>
  testFilePatterns: string[]
  entryPointPatterns: string[]
  languages: Record<string, LanguageConfig>
  docstring_generation?: DocstringConfig
  agent_config_candidates: string[]
  embedder?: EmbedderConfig
}
