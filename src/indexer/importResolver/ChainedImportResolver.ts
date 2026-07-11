import type {
  ImportKind,
  EdgeKind,
  ImportResolutionResult,
} from 'src/database/schemas'
import type { ImportResolver } from './ImportResolver'

export class ChainedImportResolver implements ImportResolver {
  constructor(private readonly resolvers: ImportResolver[]) {}

  resolve(
    moduleName: string,
    containingFile: string,
    importedNames: string[],
    importKind: ImportKind,
    edgeKind: EdgeKind,
  ): ImportResolutionResult | null {
    for (const resolver of this.resolvers) {
      const result = resolver.resolve(
        moduleName,
        containingFile,
        importedNames,
        importKind,
        edgeKind,
      )
      if (result && result.resolvedKind !== 'unresolved') {
        return result
      }
    }
    return null
  }
}
