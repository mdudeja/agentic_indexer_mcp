import type { Node } from 'web-tree-sitter'
import type { IndexedCallSite } from 'src/database/schemas/call_sites.schema'

export type ResolvedCallSite = Pick<
  IndexedCallSite['Insert'],
  | 'call_text'
  | 'callee_expression'
  | 'callee_name'
  | 'callee_base'
  | 'callee_property'
  | 'call_kind'
  | 'call_line'
  | 'call_column'
  | 'end_line'
  | 'end_column'
>

export interface CallSiteResolverWithStaticMethod {
  new (): CallSiteResolver
  getPartsOfCalleeExpression(callee_expression: string): string[]
}

export interface CallSiteResolver {
  resolve(node: Node, capturedName: string): ResolvedCallSite | null
}
