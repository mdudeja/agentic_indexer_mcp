export { EmbeddingRepository } from './EmbeddingRepository'
export { SymbolRepository } from './SymbolRepository'
export { FileRepository } from './FileRepository'
export { ImportRepository } from './ImportRepository'
export { CallSitesRepository } from './CallSitesRepository'
export { CallEdgesRepository } from './CallEdgesRepository'
export { AnalysisRepository } from './AnalysisRepository'
export { ToolUsageRepository } from './ToolUsageRepository'

/** Collapses consecutive repeated database wildcards (like %%) in a pattern string into a single wildcard. This simplifies patterns by reducing redundant wildcards without changing their matching behavior. */
export function collapseRepeatedDbWildcards(pattern: string): string {
  return pattern.replace(/\%+/g, '%')
}
