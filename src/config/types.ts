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
import { SymbolKind } from '../database/schemas'

export enum DocstringStrategy {
  none = 'none',
  comment_before = 'comment_before',
  comment_after = 'comment_after',
  either = 'either',
}

export type NodeInfo = {
  kind: SymbolKind
  name_field?: string
  source_field?: string
  parameters_field?: string
  return_type_field?: string
  docstring?: DocstringStrategy
  inherit_name_from_parent?: boolean
  heritage_node?: string
}

export type LanguageConfig = {
  extensions: string[]
  lsp_command?: string[]
  lang_features_paths?: string[]
  treesitter: {
    language_name: string
    signature_max_length?: number
  }
}

export type DocstringProviderName = 'claude' | 'gemini' | 'openai' | 'ollama'

export type DocstringConfig = {
  enabled: boolean
  provider: DocstringProviderName
  write_to_file: boolean
  exclude_generation_patterns: RegExp[]
  claude?: { api_key: string; model?: string }
  gemini?: { api_key: string; model?: string }
  openai?: { api_key: string; model?: string }
  ollama?: { model: string; base_url?: string }
}

export type EmbeddingGeneratorName =
  | 'ollama'
  | 'openai'
  | 'gemini'
  | 'anthropic'

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
  testFilePatterns: RegExp[]
  entryPointPatterns: RegExp[]
  languages: Record<string, LanguageConfig>
  docstring_generation?: DocstringConfig
  agent_config_candidates: string[]
  embedder?: EmbedderConfig
}
