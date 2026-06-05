import { Project, Node, SyntaxKind, type DefinitionInfo } from 'ts-morph'
import { SymbolKind } from 'src/config/types'
import { join, relative } from 'path'
import { existsSync } from 'fs'
import type { IndexerDB } from '../../database/IndexerDB.ts'
import { logDebug, logInfo, logWarning } from 'src/utils/logger.ts'
import { truncate } from 'src/utils/misc.ts'
import {
  Enhancer,
  type ParamInfo,
  type ResolvedCallableTypeInfo,
} from '../steps/s2_Enhancer.ts'
import { InheritenceType } from 'src/database/schemas/common.schema.ts'

const CALLABLE_SYNTAX_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Constructor,
] as const

const MAX_TYPE_TEXT_LENGTH = 500

/** Enhances code analysis by leveraging TypeScript configurations and type information to improve symbol type resolution and function call resolution. */
export class TsMorphEnhancer extends Enhancer {
  private project: Project | null = null

  private tsConfigFiles = [
    'tsconfig.json',
    'tsconfig.base.json',
    'tsconfig.app.json',
    'tsconfig.dev.json',
    'tsconfig.prod.json',
    'tsconfig.build.json',
  ]

  /** Initializes a new instance of the enhancer with the specified current working directory. */
  constructor(cwd: string) {
    super(cwd)
  }

  /** Initialize the enhancer by setting up the project configuration and returning whether initialization was successful. */
  override async init(): Promise<boolean> {
    if (this.initialized) return this.available
    this.initialized = true

    const tsconfig = this.findTsConfig()
    if (!tsconfig) {
      logWarning('[TsMorphEnhancer] No tsconfig found — enhancement disabled')
      return false
    }

    try {
      this.project = new Project({
        tsConfigFilePath: tsconfig,
        skipAddingFilesFromTsConfig: false,
        skipFileDependencyResolution: false,
      })
      this.available = true
      logInfo(`[TsMorphEnhancer] Initialized with ${tsconfig}`)
    } catch (e) {
      logWarning('[TsMorphEnhancer] Failed to initialize project:', e)
    }

    return this.available
  }

  /** Enhances symbol types for callable kinds by resolving and updating their type information from file signatures, improving code analysis capabilities. */
  override async enhanceSymbolTypesForCallables(
    store: IndexerDB,
    relPaths: string[],
  ): Promise<void> {
    if (!this.available) return
    let enhanced = 0

    for (const relPath of relPaths) {
      const absPath = join(this.cwd, relPath)

      const extn = relPath.split('.').pop() || ''
      const language = this.config.extnToLangMap[extn]
      if (!language) continue

      const symbols = await store.getSymbolsForFile(relPath)

      for (const sym of symbols) {
        if (
          !this.config.languages[
            language
          ]?.treesitter.lists.callable_kinds.includes(sym.kind)
        ) {
          continue
        }
        const sig = this.getCallableSymbolTypeInfo(
          absPath,
          sym.line,
          sym.column,
        )
        if (!sig) continue
        await store.updateCallableSymbolTypeInfo(
          sym.id,
          JSON.stringify(sig.params),
          sig.returnType,
        )
        enhanced++
      }

      this.refreshFile(absPath) // Clear cached SourceFile to free memory
    }

    logInfo(
      `[TsMorphEnhancer] Enhanced ${enhanced} callable symbols with resolved types`,
    )
  }

  /** Enhances symbol types for inherited types and interfaces by analyzing the inheritance relationships and updating type information accordingly, improving the accuracy of type resolution in the indexer database. */
  override async enhanceSymbolTypesForInheritedTypesAndInterfaces(
    store: IndexerDB,
    relPaths: string[],
  ): Promise<void> {
    if (!this.available) return
    let enhanced = 0

    for (const relPath of relPaths) {
      const absPath = join(this.cwd, relPath)

      const extn = relPath.split('.').pop() || ''
      const language = this.config.extnToLangMap[extn]
      if (!language) continue

      const symbols = await store.getSymbolsForFile(relPath)

      for (const sym of symbols) {
        if (sym.kind !== SymbolKind.interface && sym.kind !== SymbolKind.type) {
          continue
        }

        const info = this.getTypeOrInterfaceInheritenceInfo(
          absPath,
          sym.line,
          sym.column,
        )
        if (!info) continue
        await store.updateSymbolInheritance(
          sym.id,
          info.inheritsFromNames,
          info.inheritenceType,
        )
        enhanced++
      }

      this.refreshFile(absPath) // Clear cached SourceFile to free memory
    }

    logInfo(
      `[TsMorphEnhancer] Enhanced ${enhanced} type/interface symbols with inheritance info`,
    )
  }

  /** Resolves all pending unresolved calls in the indexer database. */
  override async resolveAllPendingCalls(store: IndexerDB): Promise<void> {
    if (!this.available) return

    const unresolved = await store.getUnresolvedCalls()
    if (unresolved.length === 0) return

    logInfo(
      `[TsMorphEnhancer] Resolving ${unresolved.length} unresolved call sites`,
    )

    const callableKinds =
      this.config.languages['typescript']?.treesitter.lists.callable_kinds ??
      this.config.languages['tsx']?.treesitter.lists.callable_kinds ??
      []
    let resolved = 0

    // Group by caller_file to keep the SourceFile cache hot
    const byFile = new Map<string, typeof unresolved>()
    for (const call of unresolved) {
      const list = byFile.get(call.caller_file_path) ?? []
      list.push(call)
      byFile.set(call.caller_file_path, list)
    }

    for (const [callerFile, calls] of byFile) {
      const absCallerPath = join(this.cwd, callerFile)
      for (const call of calls) {
        const def = this.resolveCallSite(
          absCallerPath,
          call.call_line!,
          call.call_column!,
          call.call_text,
        )
        if (!def) continue

        const relDefFile = relative(this.cwd, def.definitionFile)
        const sym = await store.getCallableSymbolAtLocation(
          relDefFile,
          def.definitionLine,
          callableKinds,
        )
        if (!sym) {
          let importedId = await this.getImportedId(
            store,
            call.callee_name,
            callerFile,
          )

          // Fallback: resolve the receiver's declared type and look it up in imports.
          if (!importedId) {
            const receiverType = this.resolveReceiverTypeName(
              absCallerPath,
              call.call_line!,
              call.call_column!,
            )
            if (receiverType) {
              const imports = await store.getImportsByNameAndFile(
                receiverType,
                callerFile,
              )
              if (imports.length > 0) importedId = imports[0]!.id
            }
          }
          if (importedId) {
            await store.updateImportsId(call.id, importedId)
            resolved++
          }
          continue
        }

        await store.updateCalleeId(call.id, sym.id)
        resolved++
      }
    }

    logInfo(
      `[TsMorphEnhancer] Resolved ${resolved}/${unresolved.length} call sites`,
    )
  }

  /** Refreshes the source file at the specified absolute path to ensure it reflects current file system state. */
  override refreshFile(absPath: string): void {
    if (!this.project) return
    const sf = this.project.getSourceFile(absPath)
    if (sf) sf.refreshFromFileSystemSync()
  }

  /** Finds the nearest TypeScript configuration file (tsconfig.json) by searching through directories upwards from the current working directory, up to five levels deep. */
  private findTsConfig(): string | null {
    let dir = this.cwd
    for (let i = 0; i < 5; i++) {
      for (const tsConfigFile of this.tsConfigFiles) {
        const candidate = join(dir, tsConfigFile)
        if (existsSync(candidate)) return candidate
      }
      const parent = join(dir, '..')
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  /** Retrieves or creates the source file for the specified absolute path within the project. */
  private getSourceFile(absPath: string) {
    if (!this.project) return null
    return (
      this.project.getSourceFile(absPath) ??
      this.project.addSourceFileAtPath(absPath)
    )
  }

  /** Resolves the definition site of a function call based on the provided file path, line, and column. Returns the file path and line number of the function's definition if found. */
  private resolveCallSite(
    absFilePath: string,
    callLine: number,
    callColumn: number,
    callText: string,
  ): {
    definitionFile: string
    definitionLine: number
  } | null {
    if (!this.available) return null
    try {
      const sf = this.getSourceFile(absFilePath)
      if (!sf) return null

      const charOffset = sf.compilerNode.getPositionOfLineAndCharacter(
        callLine,
        callColumn,
      )
      const nodeAtPos = sf.getDescendantAtPos(charOffset)
      if (!nodeAtPos) return null

      // Walk up to a CallExpression
      let callExpr: Node | undefined
      if (Node.isCallExpression(nodeAtPos)) {
        callExpr = nodeAtPos
      } else {
        callExpr = nodeAtPos.getFirstAncestorByKind(SyntaxKind.CallExpression)
      }
      if (!callExpr || !Node.isCallExpression(callExpr)) return null

      const ancestors = callExpr
        .getAncestors()
        .filter((a) => callText.includes(a.getText()))
      const outerCall = ancestors.filter(Node.isCallExpression).at(-1)
      const resolvedCallExpr = outerCall ?? callExpr

      const callee = resolvedCallExpr.getExpression()
      let defs: DefinitionInfo[] = []
      if (Node.isIdentifier(callee)) {
        defs = callee.getDefinitions()
      } else if (Node.isPropertyAccessExpression(callee)) {
        defs = callee.getNameNode().getDefinitions()
      }
      if (defs.length === 0) return null

      // Prefer a non-.d.ts definition (concrete implementation over type declaration)
      const def =
        defs.find((d) => !d.getSourceFile().getFilePath().endsWith('.d.ts')) ??
        defs[0]!

      const defNode = def.getNode()
      const defSf = def.getSourceFile()
      const defLine = defNode.getStartLineNumber() - 1 // convert to 0-based

      return {
        definitionFile: defSf.getFilePath(),
        definitionLine: defLine,
      }
    } catch (e) {
      logDebug('[TsMorphEnhancer] resolveCallSite failed:', e)
      return null
    }
  }

  /** Retrieves the type information (parameters + return types) of a callable symbol located at a specific position in the file. */
  private getCallableSymbolTypeInfo(
    absFilePath: string,
    line: number,
    column: number,
  ): ResolvedCallableTypeInfo | null {
    if (!this.available) return null
    try {
      const sf = this.getSourceFile(absFilePath)
      if (!sf) return null

      const charOffset = sf.compilerNode.getPositionOfLineAndCharacter(
        line,
        column,
      )
      const nodeAtPos = sf.getDescendantAtPos(charOffset)
      if (!nodeAtPos) return null

      // Find the closest callable ancestor (or the node itself)
      let fnNode: Node | undefined
      for (const kind of CALLABLE_SYNTAX_KINDS) {
        fnNode =
          nodeAtPos.getKind() === kind
            ? nodeAtPos
            : nodeAtPos.getFirstAncestorByKind(kind)
        if (fnNode) break
      }
      if (!fnNode) return null

      if (
        Node.isFunctionDeclaration(fnNode) ||
        Node.isMethodDeclaration(fnNode) ||
        Node.isArrowFunction(fnNode) ||
        Node.isFunctionExpression(fnNode) ||
        Node.isConstructorDeclaration(fnNode)
      ) {
        const params: ParamInfo[] = fnNode.getParameters().map((p) => ({
          name: p.getName(),
          type: truncate(p.getType().getText(p), MAX_TYPE_TEXT_LENGTH),
          optional: p.isOptional(),
        }))
        const returnType = truncate(
          fnNode.getReturnType().getText(fnNode),
          MAX_TYPE_TEXT_LENGTH,
        )
        return { params, returnType }
      }

      return null
    } catch (e) {
      logDebug('[TsMorphEnhancer] getSymbolSignature failed:', e)
      return null
    }
  }

  /** Gets the resolved inheritance info (base names + relationship kind) for a type alias or interface declaration at the given source location. Returns null when the symbol has no inheritance relationship or the location cannot be resolved. */
  private getTypeOrInterfaceInheritenceInfo(
    absFilePath: string,
    line: number,
    column: number,
  ): { inheritsFromNames: string; inheritenceType: InheritenceType } | null {
    if (!this.available) return null
    try {
      const sf = this.getSourceFile(absFilePath)
      if (!sf) return null

      const charOffset = sf.compilerNode.getPositionOfLineAndCharacter(
        line,
        column,
      )
      const nodeAtPos = sf.getDescendantAtPos(charOffset)
      if (!nodeAtPos) return null

      // --- Interface declaration: interface Foo extends Bar, Baz ---
      const ifaceDecl = Node.isInterfaceDeclaration(nodeAtPos)
        ? nodeAtPos
        : nodeAtPos.getFirstAncestorByKind(SyntaxKind.InterfaceDeclaration)
      if (ifaceDecl) {
        const bases = ifaceDecl
          .getExtends()
          .map((e) => e.getExpression().getText())
        if (bases.length === 0) return null
        return {
          inheritsFromNames: bases.join(','),
          inheritenceType: InheritenceType.extends,
        }
      }

      // --- Type alias: type Foo = Bar | Baz  or  Bar & Baz ---
      const typeAlias = Node.isTypeAliasDeclaration(nodeAtPos)
        ? nodeAtPos
        : nodeAtPos.getFirstAncestorByKind(SyntaxKind.TypeAliasDeclaration)
      if (typeAlias) {
        const typeNode = typeAlias.getTypeNode()
        if (!typeNode) return null

        if (Node.isUnionTypeNode(typeNode)) {
          const names = typeNode
            .getTypeNodes()
            .map((t) => t.getText())
            .filter((n) => n !== 'null' && n !== 'undefined')
          if (names.length === 0) return null
          return {
            inheritsFromNames: names.join(','),
            inheritenceType: InheritenceType.union,
          }
        }

        if (Node.isIntersectionTypeNode(typeNode)) {
          const names = typeNode.getTypeNodes().map((t) => t.getText())
          if (names.length === 0) return null
          return {
            inheritsFromNames: names.join(','),
            inheritenceType: InheritenceType.intersection,
          }
        }

        return null
      }

      return null
    } catch (e) {
      logDebug('[TsMorphEnhancer] getResolvedTypeOrInterface failed:', e)
      return null
    }
  }

  /** Retrieves the ID of an imported symbol based on the callee name and the caller file.
   * Only handles direct-name imports (e.g. `migrate()`). Method-call-on-typed-receiver
   * resolution (e.g. `this.sqlite.run()`) is handled by the `resolveReceiverTypeName`
   * fallback in `resolveAllPendingCalls`.
   */
  private async getImportedId(
    store: IndexerDB,
    calleeName: string,
    callerFile: string,
  ): Promise<string | null> {
    const imports = await store.getImportsByNameAndFile(calleeName, callerFile)
    return imports.length > 0 ? imports[0]!.id : null
  }

  /** Resolves the declared base type name of the receiver object in a method call.
   * For `this.sqlite.run(query)` the receiver is `this.sqlite`, whose type is `Database`,
   * so this returns `"Database"`. Returns null for plain function calls (no receiver).
   */
  private resolveReceiverTypeName(
    absFilePath: string,
    callLine: number,
    callColumn: number,
  ): string | null {
    if (!this.available) return null
    try {
      const sf = this.getSourceFile(absFilePath)
      if (!sf) return null

      const charOffset = sf.compilerNode.getPositionOfLineAndCharacter(
        callLine,
        callColumn,
      )
      const nodeAtPos = sf.getDescendantAtPos(charOffset)
      if (!nodeAtPos) return null

      let callExpr: Node | undefined
      if (Node.isCallExpression(nodeAtPos)) {
        callExpr = nodeAtPos
      } else {
        callExpr = nodeAtPos.getFirstAncestorByKind(SyntaxKind.CallExpression)
      }
      if (!callExpr || !Node.isCallExpression(callExpr)) return null

      const callee = callExpr.getExpression()
      if (!Node.isPropertyAccessExpression(callee)) return null

      const receiver = callee.getExpression()
      const type = receiver.getType().getNonNullableType()

      // Prefer the declared symbol name so generics are stripped automatically
      // (e.g. `Database<Schema>` → symbol name is just `Database`).
      const symbol = type.getSymbol() ?? type.getAliasSymbol()
      if (symbol) return symbol.getName()

      // Last resort: parse the leading identifier from the printed type text
      // using the per-language member_access_patterns from config.
      const typeText = type.getText()
      const extn = absFilePath.split('.').pop() ?? ''
      const language = this.config.extnToLangMap[extn]
      const patterns =
        (language &&
          this.config.languages[language]?.treesitter.lists
            .member_access_patterns) ||
        []
      for (const pattern of patterns) {
        const match = typeText.match(pattern)
        if (match?.[1]) return match[1]
      }
      return null
    } catch (e) {
      logDebug('[TsMorphEnhancer] resolveReceiverTypeName failed:', e)
      return null
    }
  }
}
