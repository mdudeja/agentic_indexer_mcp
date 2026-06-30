import type { QueryMatch, Node } from 'web-tree-sitter'
import type {
  IndexedSymbol,
  IndexedImport,
  IndexedSymbolCall,
  IndexedException,
  IndexedEnvVar,
} from '../../config/types'
import { SymbolKind } from '../../config/types'
import { getCommentText } from '../docstrings/formatComment'
import { hashSymbol } from 'src/utils/hashers'

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
  extract(matches: QueryMatch[], file_path: string, rootNode: Node): ExtractionResult
}

/**
 * Seeds a synthetic module-level symbol into nodeToSymbolId so that top-level
 * calls have a valid caller_id. Skips empty files (rootNode has no children).
 */
export function seedModuleSymbol(
  rootNode: Node,
  file_path: string,
  language: string,
  nodeToSymbolId: Map<number, string>,
  result: ExtractionResult,
): void {
  if (rootNode.childCount === 0) return
  const moduleId = hashSymbol({
    name: '<module>',
    kind: SymbolKind.module,
    file_path,
    line: 0,
    column: 0,
    signature: file_path,
  })
  nodeToSymbolId.set(rootNode.id, moduleId)
  result.symbols.push({
    id: moduleId,
    name: '<module>',
    kind: SymbolKind.module,
    file_path,
    line: 0,
    column: 0,
    end_line: rootNode.endPosition.row,
    end_column: rootNode.endPosition.column,
    signature: file_path,
    parameters_json: null,
    return_type: null,
    docstring: null,
    parent_id: null,
    inheritence: null,
    exported: false,
    decorator: null,
    language,
  })
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
