import type { LspClient } from 'src/utils/LspClient'
import { PythonCallSiteResolver } from '../callSiteResolvers'
import { GenericCallEdgeResolver } from './GenericCallEdgeResolver'
import { parseTypeNames } from 'src/utils/misc'
import type { IndexedCallEdge } from 'src/database/schemas/call_edges.schema'
import type { IndexedCallSite } from 'src/database/schemas'

/** Resolves call edges for Python code, handling function and module dependencies. */
export class PythonCallEdgeResolver extends GenericCallEdgeResolver {
  /** Initializes a new instance of the PythonCallEdgeResolver with the specified LSP client and language identifier. */
  constructor(
    override lspClient: LspClient,
    override languageId: string,
  ) {
    super(lspClient, languageId)
  }

  /** Decomposes a given expression string into its constituent parts and returns them as an array of strings. */
  override getPartsOfCalleeExpression(callee_expression: string): string[] {
    const parents =
      PythonCallSiteResolver.getPartsOfCalleeExpression(callee_expression)

    const cleanedParents = parents.map((parent) => {
      const parsedNames = parseTypeNames(parent)
      if (parsedNames.length > 0) {
        return parsedNames[parsedNames.length - 1]
      }
      return null
    })

    return cleanedParents.filter((parent): parent is string => parent !== null)
  }

  /** Resolves method calls within a single class by determining the correct call edges based on specified sources of calls and optional method identifiers. */
  override async resolveSameClassCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
    classMethodIdentifiers?: string[],
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    return super.resolveSameClassCallEdges(
      callSites,
      classMethodIdentifiers ?? ['self'],
    )
  }
}
