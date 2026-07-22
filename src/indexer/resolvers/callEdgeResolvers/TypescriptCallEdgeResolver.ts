import type { LspClient } from 'src/utils/LspClient'
import { TypescriptCallSiteResolver } from '../callSiteResolvers'
import { GenericCallEdgeResolver } from './GenericCallEdgeResolver'
import { parseTypeNames } from 'src/utils/misc'
import type { IndexedCallEdge } from 'src/database/schemas/call_edges.schema'
import type { IndexedCallSite } from 'src/database/schemas/call_sites.schema'

/** A class that resolves call edges in TypeScript projects, analyzing how functions and methods are called and connected within the codebase. */
export class TypescriptCallEdgeResolver extends GenericCallEdgeResolver {
  /** Initializes a new instance of the TypescriptCallEdgeResolver with the specified LSP client and language identifier. */
  constructor(
    override lspClient: LspClient,
    override languageId: string,
  ) {
    super(lspClient, languageId)
  }

  /** Breaks down a caller expression into its constituent parts for analysis. */
  override getPartsOfCalleeExpression(callee_expression: string): string[] {
    const parents =
      TypescriptCallSiteResolver.getPartsOfCalleeExpression(callee_expression)

    const cleanedParents = parents.map((parent) => {
      const parsedNames = parseTypeNames(parent)
      if (parsedNames.length > 0) {
        return parsedNames[parsedNames.length - 1]
      }
      return null
    })

    return cleanedParents.filter((parent): parent is string => parent !== null)
  }

  /** Resolve call edges within the same class to handle dependency injection requirements. */
  override async resolveSameClassCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
    classMethodIdentifiers?: string[],
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    return super.resolveSameClassCallEdges(
      callSites,
      classMethodIdentifiers ?? ['this'],
    )
  }
}
