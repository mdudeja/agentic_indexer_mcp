import type {
  ImportKind,
  EdgeKind,
  ImportResolutionResult,
} from 'src/database/schemas'
import type { ImportResolver } from './ImportResolver'

/** A class that chains multiple import resolvers together, allowing each resolver to attempt to resolve a module reference in sequence. If any resolver successfully handles the resolution, it returns the result; if none succeed, it returns null. */
export class ChainedImportResolver implements ImportResolver {
  /** Creates a new instance of `ChainedImportResolver` that uses the provided array of `ImportResolver` instances to handle chained import resolution. */
  constructor(private readonly resolvers: ImportResolver[]) {}

  /** Resolve module references by querying all registered resolvers until one successfully handles the resolution. Returns the result or null if no resolver finds the reference. */
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
