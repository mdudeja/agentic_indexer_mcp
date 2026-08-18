import { type Enhancer } from '../steps/s2_Enhancer.ts'
import { LspClient } from '../../utils/LspClient.ts'
import { logError, logInfo } from 'src/utils/logger.ts'
import { IndexerDB } from '../../database/IndexerDB.ts'
import * as schema from '../../database/schemas/index.ts'
import { SymbolKind } from '../../database/schemas/symbols.schema.ts'
import { InheritenceType } from '../../database/schemas/common.schema.ts'
import { eq, and, isNull, inArray, or } from 'drizzle-orm'
import { join, relative } from 'path'
import { AppStateManager } from 'src/state/index.ts'
import {
  parseArguments,
  parseTypeNames,
} from 'src/utils/misc.ts'
import { resolveWorkspacePath } from 'src/utils/paths.ts'
import { type CallEdgeResolver } from '../resolvers/callEdgeResolvers/index.ts'

/** Enhancer implementation that connects to standard Language Servers (like typescript language server, Pyright, or gopls) for runtime type queries. */
export class GenericLspEnhancer implements Enhancer {
  protected store: IndexerDB
  protected db: ReturnType<IndexerDB['getDb']>
  protected client: LspClient | null = null
  protected initialized = false
  protected available = false
  protected callEdgeResolver?: CallEdgeResolver

  /** Initializes a new instance of the GenericLspEnhancer class with the specified current working directory (cwd), LSP command, and language identifier. Sets up the database connection using IndexerDB. */
  constructor(
    protected cwd: string,
    protected lspCommand: string[],
    protected languageId: string,
  ) {
    this.store = IndexerDB.getInstance()
    this.db = this.store.getDb()
  }

  /** Initializes the LSP client and returns whether the initialization was successful. */
  async init(): Promise<boolean> {
    if (this.initialized) return this.available
    this.initialized = true

    try {
      this.client = new LspClient(this.lspCommand, this.cwd)
      await this.client.start()
      this.available = true
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to initialize LSP client:`,
        err,
      )
      this.available = false
    }

    return this.available
  }

  /** Retrieves the type or documentation information at a specified location in a file based on Language Server Protocol (LSP) hover provider support. */
  async getTypeAtLocation(
    absPath: string,
    line: number,
    column: number,
    timeoutMs = 8000,
  ): Promise<string | null> {
    if (
      !this.available ||
      !this.client ||
      !this.client.supports('hoverProvider')
    )
      return null

    this.client.ensureFileOpen(absPath, this.languageId)

    try {
      const response = await this.client.request(
        'textDocument/hover',
        {
          textDocument: {
            uri: `file://${absPath}`,
          },
          position: {
            line,
            character: column,
          },
        },
        timeoutMs,
      )

      if (!response || !response.contents) return null

      const contents = response.contents

      // Extract markdown/plaintext content from different hover payload structures
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
    } catch (err) {
      // logDebug(`[LSP Enhancer - ${this.languageId}] Hover request failed:`, err)
      return null
    }
  }

  /** Updates the file at the given absolute path and notifies external systems (like language servers) about the change. */
  refreshFile(absPath: string): void {
    if (!this.client) return

    try {
      this.client.refreshFile(absPath)
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to notify file changes:`,
        err,
      )
    }
  }

  /**
   * Opens every file in the batch (if not already open) and blocks until the
   * LSP server has finished analyzing all of them, so the subsequent
   * definition/reference/hover queries in this enhancement pass get
   * complete, settled answers. This replaces guessing with a fixed sleep and
   * running the whole enhancement step multiple times: without it, calls
   * resolved while the server is still warming up can lock in a wrong
   * answer (e.g. via the import-matching fallback) that a fully-warmed-up
   * definition lookup would have gotten right, and a later pass can never
   * revisit it since resolved calls are excluded from every subsequent query.
   */
  async prepareFiles(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) return

    try {
      const absPaths = relPaths.map((relPath) =>
        resolveWorkspacePath(join(this.cwd, relPath)),
      )
      for (const absPath of absPaths) {
        this.client.ensureFileOpen(absPath, this.languageId)
      }

      logInfo(
        `[LSP Enhancer - ${this.languageId}] Waiting for LSP to finish analyzing ${absPaths.length} files before enhancement...`,
      )
      await this.client.waitForDiagnostics(absPaths)
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to prepare files for enhancement:`,
        err,
      )
    }
  }

  /** Closes the specified files by sending notifications to the language server and removing them from the list of open documents. */
  async closeFiles(relPaths: string[]): Promise<void> {
    if (!this.client) return
    try {
      this.client.closeFiles(relPaths, this.cwd)
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to close files:`,
        err,
      )
    }
  }

  /** Enhances type information for callable symbols in specified files by adding parameter details and return types. */
  async enhanceSymbolTypesForCallables(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) {
      return
    }

    const { allCallableKinds } = await import('../../utils/allCallableKinds.ts')
    const callableKinds = await allCallableKinds()

    const symbols = await this.db
      .select({
        id: schema.symbols.id,
        name: schema.symbols.name,
        file_path: schema.symbols.file_path,
        line: schema.symbols.line,
        column: schema.symbols.column,
        signature: schema.symbols.signature,
      })
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.language, this.languageId),
          inArray(schema.symbols.kind, callableKinds),
          isNull(schema.symbols.parameters_json),
          relPaths.length > 0
            ? inArray(schema.symbols.file_path, relPaths)
            : undefined,
        ),
      )

    let enhancedCount = 0

    for (const sym of symbols) {
      const signatureInfo = await this.getHoverSignatureForSymbol(sym)
      if (!signatureInfo) continue

      const { name: paramsStr, type: returnType } = signatureInfo

      let parameters: { name: string; type: string }[] = []
      if (paramsStr && paramsStr.trim().length > 0) {
        const parsed = parseArguments(paramsStr)
        parameters = parsed.map((p) => {
          const [name, ...typeParts] = p.split(':')
          return {
            name: name?.trim() ?? '',
            type: typeParts.join(':').trim() || 'any',
          }
        })
      }

      await this.db
        .update(schema.symbols)
        .set({
          parameters_json: JSON.stringify(parameters),
          return_type: returnType || undefined,
        })
        .where(eq(schema.symbols.id, sym.id))
      enhancedCount++
    }
    logInfo(
      `[LSP Enhancer - ${this.languageId} - Callable Symbols Types] Total callable symbols: ${symbols.length}, enhanced with type info: ${enhancedCount}.`,
    )
  }

  /** Enhances interface inheritance by querying the LSP for implementation relationships and updating the database with these inherited interfaces. */
  async enhanceInterfaceInheritence(relPaths: string[]): Promise<void> {
    if (
      !this.available ||
      !this.client ||
      !this.client.supports('implementationProvider')
    ) {
      return
    }

    const interfaceSymbols = await this.db
      .select({
        id: schema.symbols.id,
        name: schema.symbols.name,
        file_path: schema.symbols.file_path,
        line: schema.symbols.line,
        column: schema.symbols.column,
      })
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.language, this.languageId),
          eq(schema.symbols.kind, SymbolKind.interface),
          relPaths.length > 0
            ? inArray(schema.symbols.file_path, relPaths)
            : undefined,
        ),
      )

    // Gather all "implements" hits from the LSP first
    type ImplementationHit = {
      implName: string
      implId: string
      filePath: string
      targetLine: number
    }
    const hits: ImplementationHit[] = []

    for (const sym of interfaceSymbols) {
      try {
        this.client.ensureFileOpen(
          join(this.cwd, sym.file_path),
          this.languageId,
        )
        const response = await this.client.request(
          'textDocument/implementation',
          {
            textDocument: { uri: `file://${join(this.cwd, sym.file_path)}` },
            position: { line: sym.line, character: sym.column },
          },
        )
        if (!response) continue

        const locations = Array.isArray(response) ? response : [response]
        for (const loc of locations) {
          if (!loc?.uri) continue
          const targetUri = (loc.uri as string).replace('file://', '')
          const filePath = relative(this.cwd, targetUri)
          const targetLine =
            loc.range?.start?.line ?? loc.targetSelectionRange?.start?.line
          if (targetLine === undefined) continue

          hits.push({
            implName: sym.name,
            implId: sym.id,
            filePath,
            targetLine,
          })
        }
      } catch (err) {
        logError(
          `[LSP Enhancer] Failed implementation request for ${sym.name}`,
          err,
        )
      }
    }

    let enhancedCount = 0
    let implSymbols: Array<{
      id: string
      file_path: string
      line: number
      inheritence: schema.Inheritence[] | null
    }> = []
    if (hits.length > 0) {
      // Single batched lookup for every implementing symbol referenced by the hits.
      const locationKey = (filePath: string, line: number) =>
        `${filePath}#${line}`
      const uniqueLocations = new Map(
        hits.map((h) => [locationKey(h.filePath, h.targetLine), h]),
      )
      implSymbols = await this.db
        .select({
          id: schema.symbols.id,
          file_path: schema.symbols.file_path,
          line: schema.symbols.line,
          inheritence: schema.symbols.inheritence,
        })
        .from(schema.symbols)
        .where(
          or(
            ...[...uniqueLocations.values()].map((h) =>
              and(
                eq(schema.symbols.file_path, h.filePath),
                eq(schema.symbols.line, h.targetLine),
              ),
            ),
          ),
        )
      const implSymbolsByLocation = new Map(
        implSymbols.map((s) => [locationKey(s.file_path, s.line), s]),
      )

      // Accumulate the new inheritance entries per implementing symbol, deduping
      // against both the existing DB state and the entries collected so far.
      const pendingUpdates = new Map<
        string,
        { existing: schema.Inheritence[]; toAdd: schema.Inheritence[] }
      >()

      for (const hit of hits) {
        const implSym = implSymbolsByLocation.get(
          locationKey(hit.filePath, hit.targetLine),
        )
        if (!implSym) continue

        let pending = pendingUpdates.get(implSym.id)
        if (!pending) {
          pending = { existing: implSym.inheritence ?? [], toAdd: [] }
          pendingUpdates.set(implSym.id, pending)
        }

        const alreadyHas =
          pending.existing.some(
            (i) =>
              i.inheritence_type === InheritenceType.implements &&
              i.inherits_from_name === hit.implName,
          ) || pending.toAdd.some((i) => i.inherits_from_name === hit.implName)
        if (alreadyHas) continue

        pending.toAdd.push({
          inheritence_type: InheritenceType.implements,
          inherits_from_name: hit.implName,
          inherits_from_id: hit.implId,
        })
      }

      for (const [implId, { existing, toAdd }] of pendingUpdates) {
        if (toAdd.length === 0) continue

        await this.db
          .update(schema.symbols)
          .set({ inheritence: [...existing, ...toAdd] })
          .where(eq(schema.symbols.id, implId))
        enhancedCount += toAdd.length
      }
    }

    logInfo(
      `[LSP Enhancer - ${this.languageId} - Interface Inheritance] Total interface symbols: ${interfaceSymbols.length}, implementation hits from LSP: ${hits.length}, symbols found: ${implSymbols.length}, enhanced inheritance entries: ${enhancedCount}.`,
    )
  }

  /** Enriches type symbols with inheritance information by analyzing their signatures and storing the relationships. This improves the language server's understanding of type hierarchies and dependencies. */
  async enhanceTypeInheritence(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) {
      return
    }

    const typeSymbols = await this.db
      .select({
        id: schema.symbols.id,
        name: schema.symbols.name,
        kind: schema.symbols.kind,
        file_path: schema.symbols.file_path,
        line: schema.symbols.line,
        column: schema.symbols.column,
        signature: schema.symbols.signature,
      })
      .from(schema.symbols)
      .where(
        and(
          eq(schema.symbols.language, this.languageId),
          inArray(schema.symbols.kind, [
            SymbolKind.class,
            SymbolKind.interface,
            SymbolKind.type,
          ]),
          relPaths.length > 0
            ? inArray(schema.symbols.file_path, relPaths)
            : undefined,
        ),
      )

    // Collect all candidate parent names up front for a single batch DB lookup
    type Candidate = {
      id: string
      inheritence: schema.Inheritence[]
    }
    const candidates: Candidate[] = []
    const allParentNames = new Set<string>()

    for (const sym of typeSymbols) {
      if (!sym.signature) continue

      const inheritence: schema.Inheritence[] = []

      if (sym.kind === SymbolKind.class || sym.kind === SymbolKind.interface) {
        // `class Foo<T> extends Bar<T> implements IFoo, IBar`
        // `interface IFoo extends IBar, IBaz`
        const extendsMatch = sym.signature.match(
          /\bextends\s+([\w<>[\], .]+?)(?=\s+implements\b|\s*\{|\s*$)/,
        )
        const implementsMatch = sym.signature.match(
          /\bimplements\s+([\w<>[\], .]+?)(?=\s*\{|\s*$)/,
        )

        if (extendsMatch) {
          inheritence.push(
            ...parseTypeNames(extendsMatch[1]!).map((n) => ({
              inheritence_type: InheritenceType.extends,
              inherits_from_name: n,
            })),
          )
        }
        if (implementsMatch) {
          inheritence.push(
            ...parseTypeNames(implementsMatch[1]!).map((n) => ({
              inheritence_type: InheritenceType.implements,
              inherits_from_name: n,
            })),
          )
        }
      }

      if (sym.kind === SymbolKind.type) {
        // `type Foo = <RHS>`
        const rhsMatch = sym.signature.match(/=\s*([\s\S]+)$/)
        if (!rhsMatch) continue
        const rhs = rhsMatch[1]!.trim()

        if (rhs.includes('&')) {
          inheritence.push(
            ...parseTypeNames(rhs.replace(/&/g, ',')).map((n) => ({
              inheritence_type: InheritenceType.intersection,
              inherits_from_name: n,
            })),
          )
        } else if (rhs.includes('|')) {
          inheritence.push(
            ...parseTypeNames(rhs.replace(/\|/g, ',')).map((n) => ({
              inheritence_type: InheritenceType.union,
              inherits_from_name: n,
            })),
          )
        } else {
          // Utility types: Pick<Base, ...>, Omit<Base, ...>, etc.
          const utilityMatch = rhs.match(/^[\w.]+\s*<\s*([\w.]+)/)
          if (utilityMatch) {
            inheritence.push({
              inheritence_type: InheritenceType.extends,
              inherits_from_name: utilityMatch[1]!,
            })
          }
        }
      }

      if (inheritence.length === 0) continue

      candidates.push({ id: sym.id, inheritence: inheritence })
      inheritence.forEach((i) => {
        allParentNames.add(i.inherits_from_name)
      })
    }

    if (candidates.length === 0) {
      logInfo(
        `[LSP Enhancer - ${this.languageId}] No type inheritance relationships found.`,
      )
      return
    }

    // Single batch lookup: which candidate names actually exist as symbols?
    const resolvedSymbols = await this.db
      .select({ name: schema.symbols.name, id: schema.symbols.id })
      .from(schema.symbols)
      .where(inArray(schema.symbols.name, [...allParentNames]))
    const resolvedNames = new Set(resolvedSymbols.map((s) => s.name))

    let enhancedCount = 0
    for (const { id, inheritence } of candidates) {
      const resolved = inheritence
        .map((i) => i.inherits_from_name)
        .filter((n) => resolvedNames.has(n))
      if (resolved.length === 0) continue

      await this.store.symbols.updateSymbolInheritance(id, inheritence)
      enhancedCount++
    }

    logInfo(
      `[LSP Enhancer - ${this.languageId} - Type Inheritance] Total type symbols: ${typeSymbols.length}, enhanced with inheritance info: ${enhancedCount}.`,
    )
  }

  /** Resolves all pending symbol calls for the specified relative file paths by attempting to resolve them through definitions, references, and imports, tracking resolution statistics. */
  async resolveAllPendingCalls(relPaths: string[]): Promise<void> {
    if (!this.available || !this.client) {
      return
    }

    try {
      // get call sites for which there is no corresponding call edge yet by a join query
      const callSitesFetched = await this.db
        .select({
          call_site: schema.call_sites,
        })
        .from(schema.call_sites)
        .leftJoin(
          schema.call_edges,
          eq(schema.call_sites.id, schema.call_edges.call_site_id),
        )
        .where(
          and(
            eq(schema.call_sites.language_name, this.languageId),
            or(
              isNull(schema.call_edges.id),
              eq(
                schema.call_edges.resolution_source,
                schema.CallResolutionSource.Unresolved,
              ),
              and(
                eq(
                  schema.call_edges.resolution_source,
                  schema.CallResolutionSource.SourceImport,
                ),
                isNull(schema.call_edges.callee_id),
              ),
            ),
            relPaths.length > 0
              ? inArray(schema.call_sites.caller_file_path, relPaths)
              : undefined,
          ),
        )
      const pendingCallSites = callSitesFetched.map((row) => row.call_site)

      logInfo(
        `[LSP Enhancer - ${this.languageId} - Symbol Calls] Resolving pending symbol calls for ${pendingCallSites.length} call sites...`,
      )
      const edges =
        await this.callEdgeResolver?.resolveCallEdges(pendingCallSites)
      if (!edges || edges.length === 0) {
        return
      }
      this.store.callEdges.upsert(edges)
    } catch (error) {
      logInfo(
        `[LSP Enhancer - ${this.languageId} - Symbol Calls] Error while resolving pending symbol calls: ${error}`,
      )
    }
  }

  /** Stops the background LSP process when disposing resources. */
  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.stop()
    }
  }

  /** Converts a hover string containing function or method information into a structured format with the function's name and return type. */
  protected convertHoverStringToSignature(hoverStr: string):
    | {
        name?: string
        type?: string
      }
    | undefined {
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
    if (!match) return

    const name = match[1]?.trim()
    const type = match[2]?.replace(/:$/, '')?.replace(/\s+/g, ' ').trim()

    return { name, type }
  }

  /** Hovers over a symbol's name (located via its signature) and parses the resulting hover string into a `{name, type}` pair. Returns `undefined` if hover info is unavailable. */
  protected async getHoverSignatureForSymbol(sym: {
    file_path: string
    name: string
    line: number
    column: number
    signature?: string | null
  }): Promise<{ name?: string; type?: string } | undefined> {
    try {
      const absPath = resolveWorkspacePath(join(this.cwd, sym.file_path))
      const hoverStr = await this.getTypeAtLocation(
        absPath,
        sym.line,
        sym.column,
      )
      if (!hoverStr) return undefined

      return this.convertHoverStringToSignature(hoverStr)
    } catch (err) {
      logError(
        `[LSP Enhancer - ${this.languageId}] Failed to get hover signature for symbol ${sym.name} in ${sym.file_path}:${sym.line}:${sym.column}`,
        err,
      )
      return
    }
  }

  /** Groups an array of rows keyed by their `file_path`, preserving each row's original relative order within its group. */
  protected groupByFilePath<T extends { file_path: string }>(
    rows: T[],
  ): Map<string, T[]> {
    const map = new Map<string, T[]>()
    for (const row of rows) {
      const arr = map.get(row.file_path) ?? []
      arr.push(row)
      map.set(row.file_path, arr)
    }
    return map
  }

  /** Batch-loads every import for the given files in a single query, grouped by file path. */
  protected async loadImportsByFile(
    filePaths: string[],
  ): Promise<Map<string, schema.IndexedImport['Select'][]>> {
    if (filePaths.length === 0) return new Map()

    const rows = await this.db
      .select()
      .from(schema.imports)
      .where(inArray(schema.imports.file_path, filePaths))

    return this.groupByFilePath(rows)
  }

  /** Batch-loads every symbol for the given files in a single query, grouped by file path. */
  protected async loadSymbolsByFile(
    filePaths: string[],
  ): Promise<Map<string, schema.IndexedSymbol['Select'][]>> {
    if (filePaths.length === 0) return new Map()

    const rows = await this.db
      .select()
      .from(schema.symbols)
      .where(inArray(schema.symbols.file_path, filePaths))

    return this.groupByFilePath(rows)
  }

  /** Finds the import whose name best matches a (possibly union) hover type string, searching only the imports already loaded for that file. Mirrors `LIKE '<name>%'` (case-insensitive prefix match). */
  protected resolveImportIdByType(
    typeStr: string[],
    importsForFile: schema.IndexedImport['Select'][] | undefined,
  ): string | undefined {
    if (!importsForFile || importsForFile.length === 0) return undefined

    const typeNames = parseTypeNames(
      typeStr
        .join(',')
        .replaceAll(/(\s+[|]\s+[A-Za-z0-9_]+)/g, '')
        .trim(),
    )
    if (typeNames.length === 0) return

    const match = importsForFile.find((imp) =>
      typeNames.some((name) => {
        const lowercaseNames =
          imp.importedNames?.map((n) => n.toLowerCase()) ?? []
        return lowercaseNames.some(
          (importedName) =>
            importedName.startsWith(name.toLowerCase()) ||
            name.toLowerCase().startsWith(importedName),
        )
      }),
    )
    return match?.id
  }
}
