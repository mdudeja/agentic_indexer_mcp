export type {
  IndexedFile,
  IndexedSymbol,
  IndexedImport,
  IndexedSymbolCall,
} from '../database/schemas'
export { SymbolKind } from '../database/schemas'

import { SymbolKind } from '../database/schemas'

export enum DocstringStrategy {
  none = 'none',
  comment_before = 'comment_before',
  comment_after = 'comment_after',
}

export type NodeInfo = {
  kind: SymbolKind
  name_field?: string
  source_field?: string
  parameters_field?: string
  return_type_field?: string
  docstring?: DocstringStrategy
  inherit_name_from_parent?: boolean
}

export type LanguageConfig = {
  extensions: string[]
  treesitter: {
    language_name: string
    block_init_marker: string
    nodes_info: Record<string, NodeInfo>
    lists: {
      exported_nodes: string[]
      container_nodes: string[]
      typedef_nodes: string[]
      decorator_nodes: string[]
      callable_nodes: string[]
      callable_kinds: SymbolKind[]
      additional_nodes: string[]
    }
  }
}

export type DocstringProviderName = 'claude' | 'gemini' | 'openai' | 'ollama'

export type DocstringConfig = {
  enabled: boolean
  provider: DocstringProviderName
  write_to_file: boolean
  claude?: { api_key: string; model?: string }
  gemini?: { api_key: string; model?: string }
  openai?: { api_key: string; model?: string }
  ollama?: { model: string; base_url?: string }
}

export type IndexerConfig = {
  enabled: boolean
  ignore_patterns: string[]
  extnToLangMap: Record<string, string>
  languages: Record<string, LanguageConfig>
  docstring_generation?: DocstringConfig
}
