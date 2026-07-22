import type { Node, QueryMatch } from 'web-tree-sitter'
import { SymbolKind } from '../../config/types'
import {
  type LanguageAdapter,
  type ExtractionResult,
  extractCallDocstring,
  seedModuleSymbol,
} from './LanguageAdapter'
import { randomUUIDv7 } from 'bun'
import { hashSymbol } from 'src/utils/hashers'
import {
  PythonImportResolver,
  ChainedImportResolver,
} from '../resolvers/importResolvers'
import { EdgeKind, ImportKind } from 'src/database/schemas/imports.schema'
import { AppStateManager } from 'src/state'
import type { ImportResolver } from '../resolvers/importResolvers/ImportResolver'
import { PythonCallSiteResolver } from '../resolvers/callSiteResolvers'
import { CallKind } from 'src/database/schemas/call_sites.schema'
import { logError } from 'src/utils/logger'

/** An adapter class for extracting and categorizing symbols, imports, calls, exceptions, environment variables, and docstrings from Python code. It processes source files to gather metadata about code elements and organizes them into structured results. */
export class PythonAdapter implements LanguageAdapter {
  private importResolver?: ChainedImportResolver
  private callSiteResolver?: PythonCallSiteResolver

  /** Initializes a new instance of the PythonAdapter class with the specified language name. */
  constructor(private readonly langName: string) {}
  /** Extracts and categorizes symbols, imports, calls, exceptions, environment variables, and docstrings from a file based on query matches. Returns an object containing the extracted elements organized by type. */
  extract(
    matches: QueryMatch[],
    file_path: string,
    rootNode: Node,
  ): ExtractionResult {
    const result: ExtractionResult = {
      symbols: [],
      imports: [],
      calls: [],
      exceptions: [],
      envVars: [],
      call_sites: [],
      explicitExports: [],
    }

    if (!this.importResolver) {
      this.createImportResolver()
    }
    if (!this.callSiteResolver) {
      this.callSiteResolver = new PythonCallSiteResolver()
    }

    const nodeToSymbolId = new Map<number, string>()

    seedModuleSymbol(rootNode, file_path, 'python', nodeToSymbolId, result)

    matches.sort((a, b) => a.patternIndex - b.patternIndex)

    // Pre first pass to gather exports
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name.startsWith('export')) {
          const capturedNode = capture.node
          if (!capturedNode) continue
          let text = capturedNode.text
          if (text.startsWith('"') && text.endsWith('"'))
            text = text.slice(1, -1)
          else if (text.startsWith("'") && text.endsWith("'"))
            text = text.slice(1, -1)
          result.explicitExports.push({
            id: randomUUIDv7(),
            file_path,
            name: text,
            line: capturedNode.startPosition.row,
            column: capturedNode.startPosition.column,
            end_line: capturedNode.endPosition.row,
            end_column: capturedNode.endPosition.column,
            decorator: null,
            docstring: null,
            exported: true,
            inheritence: null,
            kind: SymbolKind.export,
            language: 'python',
            parent_id: null,
            signature: null,
            parameters_json: null,
            return_type: null,
          })
        }
      }
    }

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

    // Second pass: attach decorators to their target symbols
    for (const match of matches) {
      const decoratorCapture = match.captures.find(
        (c) => c.name === 'symbol.decorator',
      )
      const targetCapture = match.captures.find(
        (c) => c.name === 'symbol.decorator.target',
      )
      if (decoratorCapture && targetCapture) {
        const targetId = nodeToSymbolId.get(targetCapture.node.id)
        if (targetId) {
          const symbol = result.symbols.find((s) => s.id === targetId)
          if (symbol) {
            const text = decoratorCapture.node.text
            symbol.decorator = symbol.decorator
              ? symbol.decorator + '\n' + text
              : text
          }
        }
      }
    }

    // Third pass: extract docstrings
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

    // Fourth pass: extract calls, imports, exceptions, envVars
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name.startsWith('call.')) {
          this.handleCallCapture(
            capture.node,
            file_path,
            result,
            nodeToSymbolId,
            capture.name,
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
      nameNode = node
      targetNode = node.parent!
      let parent = targetNode
      while (parent) {
        if (parent.type === 'class_definition') {
          kind = SymbolKind.method
          break
        }
        parent = parent.parent!
      }
      if (!kind) {
        kind = SymbolKind.function
      }
    } else if (captureName === 'symbol.var.decl') {
      return
    } else if (captureName === 'symbol.var.name') {
      kind = SymbolKind.var
      targetNode = node.parent!
      nameNode = node
    } else if (captureName === 'symbol.field') {
      kind = SymbolKind.property
      targetNode = node.parent!
      nameNode = node
    }

    if (!kind || !nameNode) return

    const signature = this.generateSignature(targetNode)

    const id = hashSymbol({
      name: nameNode.text,
      kind,
      file_path,
      line: nameNode.startPosition.row,
      column: nameNode.startPosition.column,
      signature: targetNode.text,
    })

    let parent_id: string | null = null
    let p = targetNode.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        parent_id = nodeToSymbolId.get(p.id)!
        if (kind === SymbolKind.property) {
          let classParentId: string | null = parent_id
          while (true) {
            classParentId =
              result.symbols.find((s) => s.id === classParentId)?.parent_id ??
              null
            if (
              classParentId &&
              result.symbols.find((s) => s.id === classParentId)?.kind ===
                SymbolKind.class
            )
              break
          }
          parent_id = classParentId
        }
        break
      }
      p = p.parent
    }

    nodeToSymbolId.set(targetNode.id, id)

    const exported =
      (targetNode.parent?.type === 'module' &&
        !nameNode.text.startsWith('_')) ||
      result.explicitExports.some((e) => e.name === nameNode!.text)

    result.symbols.push({
      id,
      name: nameNode.text,
      kind,
      file_path,
      line: node.startPosition.row,
      column: node.startPosition.column,
      end_line: node.endPosition.row,
      end_column: node.endPosition.column,
      signature: signature,
      parameters_json: null,
      return_type: null,
      docstring: null,
      parent_id,
      inheritence: null,
      exported,
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
    capturedName: string,
  ) {
    const lexicalKinds = [SymbolKind.const, SymbolKind.let, SymbolKind.var]

    let caller_id: string | null = null
    let p = node.parent
    while (p) {
      if (nodeToSymbolId.has(p.id)) {
        const capturedSymbol = result.symbols.find(
          (s) => s.id === nodeToSymbolId.get(p!.id),
        )
        if (capturedSymbol && !lexicalKinds.includes(capturedSymbol.kind)) {
          caller_id = nodeToSymbolId.get(p.id)!
          break
        }
      }
      p = p.parent
    }
    if (!caller_id) return

    const id = randomUUIDv7()
    const resolvedCallSite = this.callSiteResolver!.resolve(node, capturedName)

    if (resolvedCallSite) {
      // mark the function call as constructor if the callee_name is a class symbol
      if (resolvedCallSite.call_kind === CallKind.FunctionCall) {
        const potentialClassSymbol = result.symbols.find(
          (s) =>
            s.name === resolvedCallSite.callee_name &&
            s.kind === SymbolKind.class,
        )

        if (potentialClassSymbol) {
          resolvedCallSite.call_kind = CallKind.ConstructorCall
        }
      }

      result.call_sites!.push({
        id,
        caller_id,
        language_name: 'python',
        caller_file_path: file_path,
        ...resolvedCallSite,
      })
    } else {
      logError(
        `Failed to resolve call site for node: ${node.text} in file: ${file_path}:${node.startPosition.row}:${node.startPosition.column}`,
      )
    }

    let callExpr: Node | null = node.parent
    while (callExpr && callExpr.type !== 'call') {
      callExpr = callExpr.parent
    }
    const callText = callExpr ? callExpr.text : (node.parent?.text ?? node.text)

    result.calls.push({
      id,
      caller_id,
      callee_name: node.text,
      language_name: 'python',
      call_line: node.startPosition.row,
      call_column: node.startPosition.column,
      caller_file_path: file_path,
      call_text: callText,
      docstring: extractCallDocstring(callExpr || node),
      is_lang_feature: false,
    })
  }

  /** Captures import information from a node and stores it in the result. Used to track imported modules during code analysis or processing. */
  private handleImportCapture(
    node: Node,
    file_path: string,
    result: ExtractionResult,
  ) {
    const importedNames: Set<string> = new Set()
    const isImportFrom = node.type === 'import_from_statement'
    const moduleNameNodes = isImportFrom
      ? node.childrenForFieldName('module_name')
      : node.childrenForFieldName('name')

    if (!moduleNameNodes || moduleNameNodes.length === 0) return

    let importKind: ImportKind = isImportFrom
      ? ImportKind.Named
      : ImportKind.Namespace

    for (const moduleNameNode of moduleNameNodes) {
      if (!moduleNameNode) continue
      let moduleName =
        moduleNameNode.type === 'dotted_name'
          ? moduleNameNode.text
          : moduleNameNode.children.find((c) => c && c.type === 'dotted_name')
              ?.text
      if (!moduleName) continue

      if (moduleNameNode.type === 'relative_import') {
        const import_prefix = moduleNameNode.children.find(
          (c) => c && c.type === 'import_prefix',
        )
        if (import_prefix) {
          moduleName = import_prefix.text + moduleName
        }
      }

      const nameNodes = isImportFrom
        ? moduleNameNode.parent?.childrenForFieldName('name')
        : [moduleNameNode]

      if (!nameNodes || nameNodes.length === 0) continue

      for (const nameNode of nameNodes) {
        if (!nameNode) continue
        if (nameNode.type === 'dotted_name') {
          importedNames.add(nameNode.text)
          importKind =
            importKind === ImportKind.Namespace
              ? ImportKind.Default
              : ImportKind.Named
          continue
        }
        if (nameNode.type === 'aliased_import') {
          const dottedNameNode = nameNode.childForFieldName('name')
          const aliasNode = nameNode.childForFieldName('alias')
          if (!dottedNameNode || !aliasNode) continue
          importedNames.add(`${dottedNameNode.text} as ${aliasNode.text}`)
        }
      }

      const id = randomUUIDv7()
      const importResolutionResult = this.importResolver!.resolve(
        moduleName,
        file_path,
        Array.from(importedNames),
        this.importIsInsideTypeCheckingContext(node)
          ? ImportKind.TypeOnly
          : importKind,
        EdgeKind.Import,
      )

      if (!importResolutionResult) {
        continue
      }

      result.imports.push({
        id,
        file_path,
        ...importResolutionResult,
      })
    }
  }

  /** Determines if a given node is within a type-checking context by traversing its parent nodes and checking for specific conditions. This is used to identify whether certain imports should be treated as type-only imports. */
  private importIsInsideTypeCheckingContext(node: Node): boolean {
    let current: Node | null = node.parent

    while (current) {
      if (current.type === 'if_statement') {
        const condition = current.childForFieldName('condition')
        const consequence = current.childForFieldName('consequence')
        const alternative = current.childForFieldName('alternative')

        if (!condition) {
          current = current.parent
          continue
        }

        if (
          consequence &&
          this.isPositiveTypeCheckingCondition(condition) &&
          this.isDescendantOf(node, consequence)
        ) {
          return true
        }

        if (
          alternative &&
          this.isNegativeTypeCheckingCondition(condition) &&
          this.isDescendantOf(node, alternative)
        ) {
          return true
        }
      }

      current = current.parent
    }

    return false
  }

  /** Checks if a given condition node represents a positive type-checking condition, such as `if TYPE_CHECKING:` or similar constructs. */
  private isPositiveTypeCheckingCondition(condition: Node): boolean {
    const text = condition.text.replace(/\s+/g, '')

    return (
      text === 'TYPE_CHECKING' ||
      text === 'typing.TYPE_CHECKING' ||
      text.endsWith('.TYPE_CHECKING')
    )
  }

  /** Checks if a given condition node represents a negative type-checking condition, such as `if not TYPE_CHECKING:` or similar constructs. */
  private isNegativeTypeCheckingCondition(condition: Node): boolean {
    const text = condition.text.replace(/\s+/g, '')

    return (
      text === 'notTYPE_CHECKING' ||
      text === 'nottyping.TYPE_CHECKING' ||
      /^not.*\.TYPE_CHECKING$/.test(text)
    )
  }

  /** Checks if a given node is a descendant of another node in the AST. */
  private isDescendantOf(node: Node, ancestor: Node): boolean {
    let current: Node | null = node

    while (current) {
      if (current.id === ancestor.id) return true
      current = current.parent
    }

    return false
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
      exception_type: 'Error',
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

    const existing = result.envVars.find(
      (v) => v.symbol_id === symbol_id && v.file_path === file_path,
    )
    if (existing) return

    result.envVars.push({
      id: randomUUIDv7(),
      symbol_id,
      file_path,
      name: node.text,
      line: node.startPosition.row,
      column: node.startPosition.column,
    })
  }

  /** Generates a signature string for a given AST node by analyzing its text content, removing function bodies. */
  private generateSignature(node: Node): string {
    const lines = node.text.split('\n')
    let signature = ''
    for (let i = 0; i < lines.length; i++) {
      signature += lines[i] + '\n'
      if (lines[i]?.trim().endsWith(':')) {
        break
      }
    }
    return signature.trim()
  }

  /** Initializes an import resolver based on the current languages configuration to handle module resolution. */
  private createImportResolver() {
    const langConfig =
      AppStateManager.getInstance().getItem('config')?.languages[this.langName]
    if (!langConfig) {
      throw new Error(`Language configuration for ${this.langName} not found.`)
    }

    const importResolutionConfig = langConfig.import_resolution
    if (!importResolutionConfig) {
      throw new Error(
        `Import resolution configuration for ${this.langName} not found.`,
      )
    }

    const resolvers: ImportResolver[] = []

    switch (importResolutionConfig.resolution_strategy) {
      case 'python-first':
        resolvers.push(new PythonImportResolver(this.langName))
        break
      default:
        throw new Error(
          `Unsupported import resolution strategy: ${importResolutionConfig.resolution_strategy}`,
        )
    }

    this.importResolver = new ChainedImportResolver(resolvers)
  }
}
