export { EmbeddingRepository } from './EmbeddingRepository'
export { SymbolRepository } from './SymbolRepository'
export { FileRepository } from './FileRepository'
export { ImportRepository } from './ImportRepository'
export { CallSitesRepository } from './CallSitesRepository'
export { CallEdgesRepository } from './CallEdgesRepository'
export { AnalysisRepository } from './AnalysisRepository'
export { ToolUsageRepository } from './ToolUsageRepository'

export function collapseRepeatedDbWildcards(pattern: string): string {
  return pattern.replace(/\%+/g, '%')
}
