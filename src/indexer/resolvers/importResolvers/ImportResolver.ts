import type {
  EdgeKind,
  ImportKind,
  ImportResolutionResult,
} from 'src/database/schemas'

export interface ImportResolver {
  resolve(
    moduleName: string,
    containingFile: string,
    importedNames: string[],
    importKind: ImportKind,
    edgeKind: EdgeKind,
  ): ImportResolutionResult | null
}
