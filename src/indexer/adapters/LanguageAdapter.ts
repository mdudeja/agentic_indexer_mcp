import type { QueryMatch, Node } from 'web-tree-sitter'
import type {
  IndexedSymbol,
  IndexedImport,
  IndexedSymbolCall,
  IndexedException,
  IndexedEnvVar,
} from '../../config/types'
import { getCommentText } from '../docstrings/formatComment'

export interface ExtractionResult {
  symbols: IndexedSymbol['Select'][]
  imports: IndexedImport['Select'][]
  calls: IndexedSymbolCall['Insert'][]
  exceptions: IndexedException['Select'][]
  envVars: IndexedEnvVar['Select'][]
  explicitExports: IndexedSymbol['Select'][]
}

export interface LanguageAdapter {
  /**
   * Given the tree-sitter root node and query matches, this method extracts
   * all semantic information to index the file.
   */
  extract(matches: QueryMatch[], file_path: string): ExtractionResult
}

/** Extracts the docstring associated with a given node in the code. */
export function extractCallDocstring(node: Node | null): string | null {
  if (!node) return null

  let stmt: Node | null = node
  while (
    stmt &&
    stmt.parent &&
    !['program', 'statement_block', 'block', 'module'].includes(
      stmt.parent.type,
    )
  ) {
    stmt = stmt.parent
  }

  if (!stmt) return null

  const comments: string[] = []

  let prev = stmt.previousSibling
  const preceding: string[] = []
  while (prev && prev.type === 'comment') {
    preceding.unshift(prev.text)
    prev = prev.previousSibling
  }
  if (preceding.length > 0) comments.push(...preceding)

  let next = stmt.nextSibling
  if (
    next &&
    next.type === 'comment' &&
    next.startPosition.row === stmt.endPosition.row
  ) {
    comments.push(next.text)
  }

  if (comments.length === 0) return null
  return getCommentText(comments.join('\n'))
}
