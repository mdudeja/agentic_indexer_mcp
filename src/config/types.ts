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
  treesitter: {
    language_name: string
    block_init_marker: string
    signature_max_length: number
    nodes_info: Record<string, NodeInfo>
    lists: {
      exported_nodes: string[]
      container_nodes: string[]
      container_kinds: SymbolKind[]
      typedef_nodes: string[]
      decorator_nodes: string[]
      callable_nodes: string[]
      callable_kinds: SymbolKind[]
      additional_nodes: string[]
      member_access_patterns: Array<string | RegExp>
    }
    constructor_pattern: {
      kind: SymbolKind.method
      name: string
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
  testFilePatterns: RegExp[]
  entryPointPatterns: RegExp[]
  languages: Record<string, LanguageConfig>
  docstring_generation?: DocstringConfig
  agent_config_candidates: string[]
}
