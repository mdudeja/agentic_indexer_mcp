export type { IndexedFile, IndexedSymbol } from '../database/schemas'

export { SymbolKind } from '../database/schemas'

export interface IndexerConfig {
  enabled: boolean
  languages: Record<
    string,
    {
      extensions: string[]
      treesitter?: {
        parser?: string // Path to .so parser
      }
    }
  >
}
