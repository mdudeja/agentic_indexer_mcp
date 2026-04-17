export type { IndexedFile, IndexedSymbol, IndexedImport, SymbolReference } from '../database/schemas'
export { SymbolKind } from '../database/schemas'

import { SymbolKind } from '../database/schemas'

export enum DocstringStrategy {
  none = 'none',
  comment_before = 'comment_before',
  comment_after = 'comment_after',
}

export type NodesInfo = {
  kind: SymbolKind[]
  name_field?: string
  parameters_field?: string
  return_type_field?: string
  docstring?: DocstringStrategy
}

export type LanguageConfig = {
  extensions: string[]
  treesitter: {
    language_name: string
    nodes_info: Record<string, NodesInfo>
    container_nodes: string[]
    typedef_nodes: string[]
    decorator_nodes: string[]
  }
}

export type IndexerConfig = {
  enabled: boolean
  languages: Record<string, LanguageConfig>
}
