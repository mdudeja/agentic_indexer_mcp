import type { Node, QueryMatch } from 'web-tree-sitter'
import { SymbolKind } from '../../config/types'
import {
  type LanguageAdapter,
  type ExtractionResult,
  extractCallDocstring,
} from './LanguageAdapter'
import { randomUUIDv7 } from 'bun'
import { hashSymbol } from 'src/utils/hashers'

/** An adapter class for extracting and categorizing symbols, imports, calls, exceptions, environment variables, and docstrings from Python code. It processes source files to gather metadata about code elements and organizes them into structured results. */
export class PythonAdapter implements LanguageAdapter {
  /** Extracts and categorizes symbols, imports, calls, exceptions, environment variables, and docstrings from a file based on query matches. Returns an object containing the extracted elements organized by type. */
  extract(matches: QueryMatch[], file_path: string): ExtractionResult {
    const result: ExtractionResult = {
      symbols: [],
      imports: [],
      calls: [],
      exceptions: [],
      envVars: [],
      explicitExports: [],
    }

    const nodeToSymbolId = new Map<number, string>()

    // First pass: extract symbols
    for (const match of matches) {
      for (const capture of match.captures) {
        if (
          capture.name.startsWith('symbol.') &&
          !capture.name.startsWith('symbol.docstring')
        ) {
          this.handleSymbolCapture(
            capture.name,
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
          )
        }
      }
    }

    // Second pass: extract docstrings
    for (const match of matches) {
      const docstringCaptures = match.captures.filter(
        (c) => c.name === 'symbol.docstring',
      )
      const targetCapture = match.captures.find(
        (c) => c.name === 'symbol.docstring.target',
      )

      if (docstringCaptures.length > 0 && targetCapture) {
        const targetId = nodeToSymbolId.get(targetCapture.node.id)
        if (targetId) {
          const symbol = result.symbols.find((s) => s.id === targetId)
          if (symbol && !symbol.docstring) {
            let text = docstringCaptures[0]!.node.text
            if (text.startsWith('"""') && text.endsWith('"""'))
              text = text.slice(3, -3)
            else if (text.startsWith("'''") && text.endsWith("'''"))
              text = text.slice(3, -3)
            else if (text.startsWith('"') && text.endsWith('"'))
              text = text.slice(1, -1)
            else if (text.startsWith("'") && text.endsWith("'"))
              text = text.slice(1, -1)
            symbol.docstring = text.trim()
          }
        }
      }
    }

    // Second pass: extract calls, imports, exceptions, envVars
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name.startsWith('call.')) {
          this.handleCallCapture(
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
          )
        } else if (capture.name.startsWith('import.')) {
          this.handleImportCapture(capture.node, file_path, result)
        } else if (capture.name.startsWith('exception.')) {
          this.handleExceptionCapture(
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
          )
        } else if (capture.name.startsWith('env.')) {
          this.handleEnvCapture(capture.node, file_path, result, nodeToSymbolId)
        }
      }
    }

    return result
  }

  /** Processes and records symbol information captured during code analysis. It identifies symbols such as classes, functions, and variables, calculates unique identifiers based on their metadata, and establishes parent-child relationships between them. This method ensures that each symbol's details are stored for further use in the analysis process. */
  private handleSymbolCapture(
    captureName: string,
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
  ) {
    let kind: SymbolKind | undefined
    let nameNode: Node | null = null
    let targetNode: Node = node

    if (captureName === 'symbol.class') {
      kind = SymbolKind.class
      nameNode = node
      targetNode = node.parent!
    } else if (captureName === 'symbol.function') {
      kind = SymbolKind.function
      nameNode = node
      targetNode = node.parent!
    } else if (captureName === 'symbol.var.decl') {
      return
    } else if (captureName === 'symbol.var.name') {
      kind = SymbolKind.var
      targetNode = node.parent!
      nameNode = node
    }

    if (!kind || !nameNode) return

    const id = hashSymbol({
      name: nameNode.text,
      kind,
      file_path,
      line: targetNode.startPosition.row,
      column: targetNode.startPosition.column,
      signature: targetNode.text,
    })

    let parent_id: string | null = null
    let p = targetNode.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        parent_id = nodeToSymbolId.get(p.id)!
        break
      }
      p = p.parent
    }

    nodeToSymbolId.set(targetNode.id, id)

    result.symbols.push({
      id,
      name: nameNode.text,
      kind,
      file_path,
      line: targetNode.startPosition.row,
      column: targetNode.startPosition.column,
      end_line: targetNode.endPosition.row,
      end_column: targetNode.endPosition.column,
      signature: targetNode.text.slice(0, 100),
      parameters_json: null,
      return_type: null,
      docstring: null,
      parent_id,
      inheritence: null,
      exported: true, // simplified
      decorator: null,
      language: 'python',
    })
  }

  /** Processes a node to capture call information and record it in the result, including caller and callee details along with relevant context. */
  private handleCallCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
  ) {
    let caller_id: string | null = null
    let p = node.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        caller_id = nodeToSymbolId.get(p.id)!
        break
      }
      p = p.parent
    }
    if (!caller_id) return

    let callExpr: Node | null = node.parent
    while (callExpr && callExpr.type !== 'call') {
      callExpr = callExpr.parent
    }
    const callText = callExpr ? callExpr.text : (node.parent?.text ?? node.text)

    result.calls.push({
      id: randomUUIDv7(),
      caller_id,
      callee_name: node.text,
      language_name: 'python',
      call_line: node.startPosition.row,
      call_column: node.startPosition.column,
      caller_file_path: file_path,
      call_text: callText,
      docstring: extractCallDocstring(callExpr || node),
    })
  }

  /** "Captures import information from a node and stores it in the result. Used to track imported modules during code analysis or processing." */
  private handleImportCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
  ) {
    result.imports.push({
      id: randomUUIDv7(),
      file_path,
      module_path: node.text, // simplified
      imported_name: null,
    })
  }

  /** Captures exception information during code analysis and links exceptions to their nearest symbol in the codebase by traversing parent nodes. */
  private handleExceptionCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
  ) {
    let symbol_id: string | null = null
    let p = node.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        symbol_id = nodeToSymbolId.get(p.id)!
        break
      }
      p = p.parent
    }
    if (!symbol_id) return

    result.exceptions.push({
      id: randomUUIDv7(),
      symbol_id,
      file_path,
      exception_type: 'Exception', // simplified
      line: node.startPosition.row,
      column: node.startPosition.column,
    })
  }

  /** Captures environment variable references in a file by identifying their declaration context and adding metadata to the result. */
  private handleEnvCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
    nodeToSymbolId: Map<number, string>,
  ) {
    let symbol_id: string | null = null
    let p = node.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        symbol_id = nodeToSymbolId.get(p.id)!
        break
      }
      p = p.parent
    }
    if (!symbol_id) return

    result.envVars.push({
      id: randomUUIDv7(),
      symbol_id,
      file_path,
      name: node.text,
      line: node.startPosition.row,
      column: node.startPosition.column,
    })
  }
}
