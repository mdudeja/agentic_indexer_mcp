import type { IndexedCallEdge, IndexedCallSite } from 'src/database/schemas'

export interface CallEdgeResolver {
  resolveCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']>>

  resolveDynamicCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null>

  resolveSameClassCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
    classMethodIdentifiers?: string[],
  ): Promise<Array<IndexedCallEdge['Insert']> | null>

  resolveSameFileCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null>

  resolveImportBoundCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null>

  resolveGlobalListBuiltInCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null>

  resolveLSPDefinitionCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null>

  resolveLSPHoverCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null>

  generateUnresolvedCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null>

  getPartsOfCalleeExpression(callee_expression: string): string[]
}
