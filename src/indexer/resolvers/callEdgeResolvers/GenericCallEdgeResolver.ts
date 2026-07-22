import {
  type IndexedCallSite,
  type IndexedCallEdge,
  CallKind,
  CallTargetKind,
  CallResolutionSource,
  SymbolKind,
  ImportKind,
  EdgeKind,
  type IndexedImport,
} from 'src/database/schemas'
import type { CallEdgeResolver } from './CallEdgeResolver'
import { logDebug, logError, logInfo } from 'src/utils/logger'
import type { SupportedLanguage } from 'tree-sitter-wasm'
import { randomUUIDv7 } from 'bun'
import {
  getConfidenceByCallResolutionSource,
  processImportedNames,
} from './utils'
import { allCallableKinds } from 'src/utils/allCallableKinds'
import { LspClient } from 'src/utils/LspClient'
import { IndexerDB } from 'src/database/IndexerDB'
import { getBuiltins } from 'src/constants/callEdgeBuiltins'
import { AppStateManager } from 'src/state'
import { resolveWorkspacePath } from 'src/utils/paths'
import { dirname, join, relative } from 'path'
import { parseTypeNames } from 'src/utils/misc'
import { readFileSync } from 'fs'
;``
/** A resolver for managing and resolving call edges between nodes or components. It provides a generic implementation to handle dependencies and connections in different contexts. */
export class GenericCallEdgeResolver implements CallEdgeResolver {
  protected symbolsRepo = IndexerDB.getInstance().symbols
  protected importsRepo = IndexerDB.getInstance().imports

  /** Initializes a new instance of the GenericCallEdgeResolver class, which manages call edge resolution for a specific language server protocol (LSP) client and language ID combination. */
  constructor(
    protected lspClient: LspClient,
    protected languageId: string,
  ) {}

  /** Processes an array of call sites to generate corresponding call edges that can be inserted. */
  async resolveCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']>> {
    logInfo(`Resolving call edges for ${callSites.length} call sites...`)

    const dynamicCallSites = callSites.filter((callSite) => {
      return callSite.call_kind === CallKind.DynamicCall
    })

    const dynamicCallEdges =
      await this.resolveDynamicCallEdges(dynamicCallSites)
    logInfo(
      `Resolved ${dynamicCallEdges?.length ?? 0} dynamic call edges. Remaining: ${callSites.length - (dynamicCallEdges?.length ?? 0)}`,
    )

    callSites = callSites.filter((callSite) => {
      return callSite.call_kind !== CallKind.DynamicCall
    })
    const sameClassCallEdges = await this.resolveSameClassCallEdges(callSites)
    logInfo(
      `Resolved ${sameClassCallEdges?.length ?? 0} same class call edges. Remaining: ${callSites.length - (sameClassCallEdges?.length ?? 0)}`,
    )

    callSites = callSites.filter((callSite) => {
      return !sameClassCallEdges?.some(
        (edge) => edge.call_site_id === callSite.id,
      )
    })
    const sameFileCallEdges = await this.resolveSameFileCallEdges(callSites)
    logInfo(
      `Resolved ${sameFileCallEdges?.length ?? 0} same file call edges. Remaining: ${callSites.length - (sameFileCallEdges?.length ?? 0)}`,
    )

    callSites = callSites.filter((callSite) => {
      return !sameFileCallEdges?.some(
        (edge) => edge.call_site_id === callSite.id,
      )
    })
    const importBoundCallEdges =
      await this.resolveImportBoundCallEdges(callSites)
    logInfo(
      `Resolved ${importBoundCallEdges?.length ?? 0} import bound call edges. Remaining: ${callSites.length - (importBoundCallEdges?.length ?? 0)}`,
    )

    callSites = callSites.filter((callSite) => {
      return !importBoundCallEdges?.some(
        (edge) => edge.call_site_id === callSite.id,
      )
    })
    const globalListBuiltInCallEdges =
      await this.resolveGlobalListBuiltInCallEdges(callSites)
    logInfo(
      `Resolved ${globalListBuiltInCallEdges?.length ?? 0} global list built-in call edges. Remaining: ${callSites.length - (globalListBuiltInCallEdges?.length ?? 0)}`,
    )

    callSites = callSites.filter((callSite) => {
      return !globalListBuiltInCallEdges?.some(
        (edge) => edge.call_site_id === callSite.id,
      )
    })
    const lspDefinitionCallEdges =
      await this.resolveLSPDefinitionCallEdges(callSites)
    logInfo(
      `Resolved ${lspDefinitionCallEdges?.length ?? 0} LSP definition call edges. Remaining: ${callSites.length - (lspDefinitionCallEdges?.length ?? 0)}`,
    )

    callSites = callSites.filter((callSite) => {
      return !lspDefinitionCallEdges?.some(
        (edge) => edge.call_site_id === callSite.id,
      )
    })
    const lspHoverCallEdges = await this.resolveLSPHoverCallEdges(callSites)
    logInfo(
      `Resolved ${lspHoverCallEdges?.length ?? 0} LSP hover call edges. Remaining: ${callSites.length - (lspHoverCallEdges?.length ?? 0)}`,
    )

    callSites = callSites.filter((callSite) => {
      return !lspHoverCallEdges?.some(
        (edge) => edge.call_site_id === callSite.id,
      )
    })
    const unresolvedCallEdges =
      await this.generateUnresolvedCallEdges(callSites)
    logInfo(
      `Generated ${unresolvedCallEdges?.length ?? 0} unresolved call edges. Remaining: ${callSites.length - (unresolvedCallEdges?.length ?? 0)}`,
    )

    return [
      ...(dynamicCallEdges ?? []),
      ...(sameClassCallEdges ?? []),
      ...(sameFileCallEdges ?? []),
      ...(importBoundCallEdges ?? []),
      ...(globalListBuiltInCallEdges ?? []),
      ...(lspDefinitionCallEdges ?? []),
      ...(lspHoverCallEdges ?? []),
      ...(unresolvedCallEdges ?? []),
    ]
  }

  /** Processes dynamic call sites to determine where their targets can be inserted into the control flow graph. */
  async resolveDynamicCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    return callSites.map((callSite) => ({
      id: randomUUIDv7(),
      call_site_id: callSite.id,
      caller_id: callSite.caller_id,
      target_kind: CallTargetKind.Dynamic,
      resolution_source: CallResolutionSource.DynamicPattern,
      confidence: getConfidenceByCallResolutionSource(
        CallResolutionSource.DynamicPattern,
      ),
    }))
  }

  /** Resolves and identifies call edges where methods are called within the same class. This helps optimize analysis by focusing on internal method calls. */
  async resolveSameClassCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
    classMethodIdentifiers?: string[],
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    if (!classMethodIdentifiers) {
      classMethodIdentifiers = ['this']
    }

    const potentialCandidates = callSites.filter(
      (callSite) =>
        callSite.call_kind === CallKind.MethodCall &&
        callSite.callee_property &&
        classMethodIdentifiers.some((identifier) =>
          callSite.callee_base?.startsWith(identifier),
        ),
    )
    logDebug(
      `Found ${potentialCandidates.length} potential same-class call edges`,
    )

    if (!potentialCandidates.length) {
      return null
    }

    const matchedSymbols = await this.symbolsRepo.getSymbolsByNames(
      potentialCandidates
        .map((callSite) => callSite.callee_property)
        .filter(Boolean) as string[],
    )
    const classProperties = (
      await this.symbolsRepo.getForFiles(
        potentialCandidates.map((callSite) => callSite.caller_file_path),
      )
    ).filter((symbol) => symbol.kind === SymbolKind.property)

    const callEdges: Array<IndexedCallEdge['Insert']> = []
    potentialCandidates.forEach((callSite) => {
      const matchedSymbol = matchedSymbols.find(
        (symbol) =>
          symbol.kind === SymbolKind.method &&
          callSite.callee_property === symbol.name &&
          callSite.caller_id === symbol.parent_id,
      )

      if (matchedSymbol) {
        callEdges.push({
          id: randomUUIDv7(),
          call_site_id: callSite.id,
          caller_id: callSite.caller_id,
          target_kind: CallTargetKind.ProjectSymbol,
          callee_id: matchedSymbol.id,
          resolution_source: CallResolutionSource.SameClass,
          confidence: getConfidenceByCallResolutionSource(
            CallResolutionSource.SameClass,
          ),
        })

        return
      }

      if (!classProperties.length) {
        return
      }

      const matchedProperty = classProperties.find(
        (property) =>
          callSite.callee_expression.startsWith(property.name) ||
          classMethodIdentifiers?.some((identifier) =>
            callSite.callee_expression.startsWith(
              `${identifier}.${property.name}`,
            ),
          ),
      )

      if (matchedProperty) {
        callEdges.push({
          id: randomUUIDv7(),
          call_site_id: callSite.id,
          caller_id: callSite.caller_id,
          target_kind: CallTargetKind.ProjectSymbol,
          callee_id: matchedProperty.id,
          resolution_source: CallResolutionSource.SameClass,
          confidence: getConfidenceByCallResolutionSource(
            CallResolutionSource.SameClass,
          ),
        })
      }
    })

    return callEdges
  }

  /** Resolves and generates call edges within the same file based on provided call sites. */
  async resolveSameFileCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    const callableKinds = await allCallableKinds()
    const byFileMap = new Map<string, Array<IndexedCallSite['Select']>>()
    callSites.forEach((callSite) => {
      if (!byFileMap.has(callSite.caller_file_path)) {
        byFileMap.set(callSite.caller_file_path, [])
      }
      byFileMap.get(callSite.caller_file_path)?.push(callSite)
    })

    const callEdges: Array<IndexedCallEdge['Insert']> = []
    for (const [filePath, fileCallSites] of byFileMap.entries()) {
      const fileSymbols = await this.symbolsRepo?.getForFile(filePath)
      if (!fileSymbols?.length) {
        continue
      }

      fileCallSites.forEach((callSite) => {
        const matchedSymbol = fileSymbols.find((symbol) => {
          const callableSymbol =
            symbol.name === callSite.callee_name &&
            callableKinds.includes(symbol.kind as SymbolKind)

          const lexicalSymbol =
            callSite.callee_expression.startsWith(symbol.name) &&
            [SymbolKind.let, SymbolKind.const, SymbolKind.var].includes(
              symbol.kind as SymbolKind,
            ) &&
            symbol.parent_id === callSite.caller_id
          return callableSymbol || lexicalSymbol
        })

        if (matchedSymbol) {
          callEdges.push({
            id: randomUUIDv7(),
            call_site_id: callSite.id,
            caller_id: callSite.caller_id,
            target_kind: CallTargetKind.ProjectSymbol,
            callee_id: matchedSymbol.id,
            resolution_source: CallResolutionSource.SameFile,
            confidence: getConfidenceByCallResolutionSource(
              CallResolutionSource.SameFile,
            ),
          })
        }
      })
    }

    return callEdges
  }

  /** Resolves and returns the import-bound call edges based on the provided call sites. */
  async resolveImportBoundCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    const byFileMap = new Map<string, Array<IndexedCallSite['Select']>>()
    callSites.forEach((callSite) => {
      const filePath = callSite.caller_file_path
      if (!byFileMap.has(filePath)) {
        byFileMap.set(filePath, [])
      }
      byFileMap.get(filePath)?.push(callSite)
    })

    const importsByFile = new Map<string, Array<IndexedImport['Select']>>()
    for (const filePath of byFileMap.keys()) {
      const imports = await this.importsRepo.getByFilePath(filePath)
      if (imports) {
        importsByFile.set(filePath, imports)
      }
    }

    const callEdges: Array<IndexedCallEdge['Insert']> = []
    byFileMap.forEach((fileCallSites, filePath) => {
      const imports = importsByFile.get(filePath)
      if (!imports) {
        return
      }

      fileCallSites.forEach((callSite) => {
        const matchedImport = imports.find((imp) => {
          const importedNames = processImportedNames(imp.importedNames ?? [])
          const importKindMatch = ![
            ImportKind.SideEffect,
            ImportKind.TypeOnly,
            ImportKind.Unresolved,
          ].includes(imp.importKind)
          const edgeKindMatch = imp.edgeKind === EdgeKind.Import
          const nameMatch =
            importedNames.includes(callSite.callee_name) ||
            (callSite.callee_base &&
              importedNames.includes(callSite.callee_base))

          return importKindMatch && edgeKindMatch && nameMatch
        })

        if (!matchedImport) {
          return
        }

        callEdges.push({
          id: randomUUIDv7(),
          call_site_id: callSite.id,
          caller_id: callSite.caller_id,
          target_kind: CallTargetKind.Import,
          imports_id: matchedImport.id,
          resolution_source: matchedImport.isExternal
            ? CallResolutionSource.ExternalImport
            : CallResolutionSource.SourceImport,
          confidence: getConfidenceByCallResolutionSource(
            matchedImport.isExternal
              ? CallResolutionSource.ExternalImport
              : CallResolutionSource.SourceImport,
          ),
        })
      })
    })

    return callEdges
  }

  /** Resolve built-in function calls within a global list context. */
  async resolveGlobalListBuiltInCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    const callEdges: Array<IndexedCallEdge['Insert']> = []
    callSites.forEach((callSite) => {
      const builtins = getBuiltins(
        this.languageId as SupportedLanguage,
        callSite.call_kind,
      )
      if (!builtins) {
        return
      }

      if (
        builtins.has(callSite.callee_name) ||
        builtins.has(callSite.callee_base ?? '')
      ) {
        callEdges.push({
          id: randomUUIDv7(),
          call_site_id: callSite.id,
          caller_id: callSite.caller_id,
          target_kind: CallTargetKind.Builtin,
          resolution_source: CallResolutionSource.BuiltinList,
          confidence: getConfidenceByCallResolutionSource(
            CallResolutionSource.BuiltinList,
          ),
        })
      }
    })
    return callEdges
  }

  /** Resolves references to definitions for call edges based on provided call sites. */
  async resolveLSPDefinitionCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    if (!this.lspClient || !this.lspClient.supports('definitionProvider')) {
      logError(
        'LSP client is not initialized or does not support definitionProvider. Cannot resolve LSP definition call edges.',
      )
      return null
    }
    const cwd = AppStateManager.getInstance().getItem('root')
    const config = AppStateManager.getInstance().getItem('config')

    if (!cwd || !config) {
      logError(
        'Root directory or config is not set in AppStateManager. Cannot resolve LSP definition call edges.',
      )
      return null
    }

    const byFileMap = new Map<string, Array<IndexedCallSite['Select']>>()
    callSites.forEach((callSite) => {
      const filePath = callSite.caller_file_path
      if (!byFileMap.has(filePath)) {
        byFileMap.set(filePath, [])
      }
      byFileMap.get(filePath)?.push(callSite)
    })

    const callEdges: Array<IndexedCallEdge['Insert']> = []
    for (const [filePath, fileCallSites] of byFileMap.entries()) {
      if (fileCallSites.length === 0) {
        continue
      }

      const absPath = resolveWorkspacePath(join(cwd, filePath))
      this.lspClient.ensureFileOpen(absPath, this.languageId)

      for (const callSite of fileCallSites) {
        if (!callSite.call_line || !callSite.call_column) {
          continue
        }

        try {
          const response = await this.lspClient.request(
            'textDocument/definition',
            {
              textDocument: { uri: `file://${absPath}` },
              position: {
                line: callSite.call_line - 1,
                character: callSite.call_column - 1,
              },
            },
          )
          if (!response || response.length === 0) {
            continue
          }
          const locations = Array.isArray(response) ? response : [response]
          for (const location of locations) {
            const targetFilePath = relative(
              cwd,
              (location.uri as string).replace('file://', ''),
            )
            const targetLine = location.range.start.line
            const targetColumn = location.range.start.character

            const matchedSymbol = await this.getMatchingSymbol(
              targetFilePath,
              targetLine,
              targetColumn,
            )

            if (matchedSymbol) {
              callEdges.push({
                id: randomUUIDv7(),
                call_site_id: callSite.id,
                caller_id: callSite.caller_id,
                target_kind: CallTargetKind.ProjectSymbol,
                callee_id: matchedSymbol.id,
                resolution_source: CallResolutionSource.LspDefinition,
                confidence: getConfidenceByCallResolutionSource(
                  CallResolutionSource.LspDefinition,
                ),
              })
              continue
            }

            const isLangFeatureCall = config.languages[
              this.languageId
            ]?.lang_features_paths?.some((langFeaturePath) =>
              targetFilePath.startsWith(langFeaturePath),
            )

            if (isLangFeatureCall) {
              callEdges.push({
                id: randomUUIDv7(),
                call_site_id: callSite.id,
                caller_id: callSite.caller_id,
                target_kind: CallTargetKind.Builtin,
                resolution_source: CallResolutionSource.LspDefinition,
                confidence: getConfidenceByCallResolutionSource(
                  CallResolutionSource.LspDefinition,
                ),
              })
              continue
            }

            const matchedImport = await this.getMatchingImport(
              filePath,
              targetFilePath,
              callSite.callee_expression,
            )

            if (matchedImport) {
              callEdges.push({
                id: randomUUIDv7(),
                call_site_id: callSite.id,
                caller_id: callSite.caller_id,
                target_kind: CallTargetKind.Import,
                imports_id: matchedImport.id,
                resolution_source: CallResolutionSource.LspDefinition,
                confidence: getConfidenceByCallResolutionSource(
                  CallResolutionSource.LspDefinition,
                ),
              })
              continue
            }
          }
        } catch (err) {
          logError(
            `[CallEdgeResolver - ${this.languageId}] Error resolving LSP definition for call site ${callSite.id} in file ${filePath}:`,
            err,
          )
          continue
        }
      }
    }
    return callEdges
  }

  /** Resolve call relationships for hover events in the Language Server Protocol (LSP) context. */
  async resolveLSPHoverCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    if (!this.lspClient || !this.lspClient.supports('hoverProvider')) {
      logError(
        'LSP client is not initialized or does not support hoverProvider. Cannot resolve LSP hover call edges.',
      )
      return null
    }

    const cwd = AppStateManager.getInstance().getItem('root')

    if (!cwd) {
      logError(
        'Root directory is not set in AppStateManager. Cannot resolve LSP hover call edges.',
      )
      return null
    }

    const byFileMap = new Map<string, Array<IndexedCallSite['Select']>>()
    callSites.forEach((callSite) => {
      const filePath = callSite.caller_file_path
      if (!byFileMap.has(filePath)) {
        byFileMap.set(filePath, [])
      }
      byFileMap.get(filePath)?.push(callSite)
    })

    const callEdges: Array<IndexedCallEdge['Insert']> = []
    for (const [filePath, fileCallSites] of byFileMap.entries()) {
      if (fileCallSites.length === 0) {
        continue
      }

      const absPath = resolveWorkspacePath(join(cwd, filePath))
      this.lspClient.ensureFileOpen(absPath, this.languageId)
      for (const callSite of fileCallSites) {
        if (!callSite.call_line || !callSite.call_column) {
          continue
        }

        const parents = this.getPartsOfCalleeExpression(
          callSite.callee_expression,
        )
          .slice(0, -1)
          .reverse()
        if (parents.length === 0) {
          continue
        }

        const calleeIndex = callSite.callee_expression.lastIndexOf(
          callSite.callee_name,
        )
        if (calleeIndex === -1) {
          continue
        }

        let relevantText =
          callSite.callee_base ||
          callSite.callee_expression.substring(0, calleeIndex)
        for (const parent of parents) {
          const parentIndex = relevantText.lastIndexOf(parent)
          relevantText = relevantText.substring(0, parentIndex)
          if (parentIndex === -1) {
            continue
          }
          const linesBetweenCallAndParent =
            callSite.call_text
              .substring(parentIndex + parent.length, calleeIndex)
              .split('\n').length - 1

          try {
            const hoverLine = callSite.call_line - 1 - linesBetweenCallAndParent
            const hoverColumn = this.getHoverColumn(
              hoverLine,
              parent,
              callSite.caller_file_path,
            )

            const response = await this.lspClient.request(
              'textDocument/hover',
              {
                textDocument: { uri: `file://${absPath}` },
                position: {
                  line: hoverLine,
                  character: hoverColumn,
                },
              },
            )
            if (!response || !response.contents) {
              continue
            }
            const hoverString = this.parseHoverstringContents(response.contents)
            if (!hoverString) {
              continue
            }
            const signature = this.convertHoverstringToSignature(hoverString)
            if (!signature || !signature.name || !signature.type) {
              continue
            }
            const importsForFile =
              await this.importsRepo.getByFilePath(filePath)
            const matchingImport = importsForFile.find((imp) => {
              const importedNames = processImportedNames(
                imp.importedNames ?? [],
                true,
              )
              return (
                importedNames.includes(signature.name!) ||
                importedNames.includes(signature.type!)
              )
            })
            if (matchingImport) {
              callEdges.push({
                id: randomUUIDv7(),
                call_site_id: callSite.id,
                caller_id: callSite.caller_id,
                target_kind: CallTargetKind.Import,
                imports_id: matchingImport.id,
                resolution_source: CallResolutionSource.LspHover,
                confidence: getConfidenceByCallResolutionSource(
                  CallResolutionSource.LspHover,
                ),
              })
              break
            }
          } catch (err) {
            logError(
              `[CallEdgeResolver - ${this.languageId}] Error resolving LSP hover for call site ${callSite.id} in file ${filePath}:`,
              err,
            )
            continue
          }
        }
      }
    }
    return callEdges
  }

  /** Generates unresolved call edges from given call sites for dependency tracking or static analysis purposes. */
  async generateUnresolvedCallEdges(
    callSites: Array<IndexedCallSite['Select']>,
  ): Promise<Array<IndexedCallEdge['Insert']> | null> {
    return callSites.map((callSite) => ({
      id: randomUUIDv7(),
      call_site_id: callSite.id,
      caller_id: callSite.caller_id,
      target_kind: CallTargetKind.Unresolved,
      resolution_source: CallResolutionSource.Unresolved,
      confidence: getConfidenceByCallResolutionSource(
        CallResolutionSource.Unresolved,
      ),
    }))
  }

  /** Breaks down a caller expression string into its constituent parts (e.g., module and function name). */
  getPartsOfCalleeExpression(_callee_expression: string): string[] {
    throw new Error('Method not implemented.')
  }

  /** Gets the matching symbol at the specified location in the given file. */
  private async getMatchingSymbol(
    file_path: string,
    line: number,
    column: number,
  ) {
    return this.symbolsRepo.getCallableAtLocation(file_path, line, column, [
      ...(await allCallableKinds()),
      SymbolKind.class,
    ])
  }

  /** Identifies whether there is an existing import in the specified file path that matches the provided expression. */
  private async getMatchingImport(
    filePath: string,
    resolvedPath: string,
    callee_expression: string,
  ) {
    let importRow: IndexedImport['Select'] | null = null
    const allImportsForFile = await this.importsRepo.getByFilePath(filePath)
    importRow =
      allImportsForFile.find((imp) => {
        return (
          imp.edgeKind === EdgeKind.Import &&
          imp.resolvedPath &&
          dirname(resolvedPath) === dirname(imp.resolvedPath)
        )
      }) ?? null

    if (!importRow) {
      const parents =
        this.getPartsOfCalleeExpression(callee_expression).reverse()
      const matchingImport = allImportsForFile.find((imp) => {
        const importedNames = processImportedNames(imp.importedNames ?? [])
        return parents.some((parent) => importedNames.includes(parent))
      })
      if (matchingImport) {
        importRow = matchingImport
      }
    }

    return importRow
  }

  /** Parse and extract the contents from a hover string, returning the result as a string or null. */
  private parseHoverstringContents(contents: any): string | null {
    if (typeof contents === 'string') {
      return contents
    }
    if (Array.isArray(contents)) {
      return contents
        .map((c) => (typeof c === 'string' ? c : c.value))
        .join('\n')
    }
    if (contents.value) {
      return contents.value
    }
    return null
  }

  /** Converts a hover string into its corresponding signature representation. */
  private convertHoverstringToSignature(
    hoverStr: string,
  ): { name?: string; type?: string } | null {
    const allLanguages = Object.keys(
      AppStateManager.getInstance().getItem('config')?.languages ?? {},
    )
    const languageRegexString = allLanguages.join('|')
    // Extract markdown code blocks to avoid noise from description
    const codeBlocks = hoverStr.match(/```[a-z]*\n([\s\S]*?)```/g)
    const contentToParse = codeBlocks
      ? codeBlocks
          .map((b) =>
            b.replace(new RegExp(`\`\`\`(${languageRegexString})\n`, 'g'), ''),
          )
          .map((b) => b.replace(/```/g, ''))
          .join('\n')
      : hoverStr

    // Strip LSP prefixes like "(method)", "(alias)", "(function)"
    const cleanContent = contentToParse.replace(/^\([a-z]+\)\s*/i, '')

    const isCall = cleanContent.includes('(') && cleanContent.includes(')')

    const match = isCall
      ? cleanContent.match(/\((.*?)\)(?:\s*)(?:->|=>|:)\s*([^\\\n$(]+)?/s)
      : cleanContent.match(/(.*?)(?:\s*)(?:->|=>|:)\s*([^\\\n$(]+)?/s)
    if (!match) return null

    const name = match[1]?.trim()
    let type = match[2]?.replace(/:$/, '')?.replace(/\s+/g, ' ').trim()
    if (type) {
      type = (parseTypeNames(type) ?? []).join(' ')
    }

    return { name, type: type?.trim() }
  }

  /** Get the column position where the hover effect appears on the specified line in the given file. */
  private getHoverColumn(
    hoverline: number,
    parentName: string,
    relativeFilePath: string,
  ): number {
    const file = readFileSync(resolveWorkspacePath(relativeFilePath), 'utf-8')
    const fileContents = file.split('\n')
    if (hoverline < 0 || hoverline >= fileContents.length) {
      throw new Error(
        `Hover line ${hoverline + 1} is out of bounds for file ${relativeFilePath}`,
      )
    }
    const lineContent = fileContents[hoverline]
    const parentIndex = lineContent!.lastIndexOf(parentName)
    if (parentIndex === -1) {
      throw new Error(
        `Parent name "${parentName}" not found in line ${hoverline + 1} of file ${relativeFilePath}`,
      )
    }
    return parentIndex
  }
}
