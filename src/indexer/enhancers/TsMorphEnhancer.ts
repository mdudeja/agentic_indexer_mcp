import { Project, Node, SyntaxKind, type DefinitionInfo } from 'ts-morph'
import { join, relative } from 'path'
import { existsSync } from 'fs'
import type { IndexerDB } from '../../database/IndexerDB.ts'
import { logDebug, logInfo, logWarning } from 'src/utils/logger.ts'
import { truncate } from 'src/utils/misc.ts'
import {
  Enhancer,
  type ParamInfo,
  type ResolvedSignature,
} from '../steps/s2_Enhancer.ts'

const CALLABLE_SYNTAX_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Constructor,
]

const MAX_TYPE_TEXT_LENGTH = 500

/** Provides TypeScript-specific project enhancement by using ts-morph to resolve symbol signatures and call site definitions. */
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

  /** Initializes a new TsMorphEnhancer instance with the specified working directory. */
  constructor(cwd: string) {
    super(cwd)
  }

  /** Initializes the project by locating a tsconfig file and setting up the ts-morph instance, returning true if successful. */
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

  /** Asynchronously resolves and updates parameter and return type information in the database for callable symbols within the specified file paths. */
  override async enhanceSymbolTypes(
    store: IndexerDB,
    relPaths: string[],
  ): Promise<void> {
    if (!this.available) return
    let enhanced = 0

    for (const relPath of relPaths) {
      const absPath = join(this.cwd, relPath)
      const symbols = await store.getSymbolsForFile(relPath)

      for (const sym of symbols) {
        if (
          !this.config.languages.tsx?.treesitter.lists.callable_kinds.includes(
            sym.kind,
          )
        ) {
          continue
        }
        const sig = this.getSymbolSignature(absPath, sym.line, sym.column)
        if (!sig) continue
        await store.updateSymbolTypeInfo(
          sym.id,
          JSON.stringify(sig.params),
          sig.returnType,
        )
        enhanced++
      }

      this.refreshFile(absPath) // Clear cached SourceFile to free memory
    }

    logInfo(
      `[TsMorphEnhancer] Enhanced ${enhanced} symbols with resolved types`,
    )
  }

  /** Resolves all pending function call sites in the database by mapping them to their corresponding symbol definitions and updating the store. */
  override async resolveAllPendingCalls(store: IndexerDB): Promise<void> {
    if (!this.available) return

    const unresolved = await store.getUnresolvedCalls()
    if (unresolved.length === 0) return

    logInfo(
      `[TsMorphEnhancer] Resolving ${unresolved.length} unresolved call sites`,
    )
    let resolved = 0

    // Group by caller_file to keep the SourceFile cache hot
    const byFile = new Map<string, typeof unresolved>()
    for (const call of unresolved) {
      const list = byFile.get(call.caller_file) ?? []
      list.push(call)
      byFile.set(call.caller_file, list)
    }

    for (const [callerFile, calls] of byFile) {
      const absCallerPath = join(this.cwd, callerFile)
      for (const call of calls) {
        const def = this.resolveCallSite(
          absCallerPath,
          call.call_line,
          call.call_column,
        )
        if (!def) continue

        const relDefFile = relative(this.cwd, def.definitionFile)
        const sym = await store.getSymbolAtLocation(
          relDefFile,
          def.definitionLine,
        )
        if (!sym) continue

        await store.updateCalleeId(call.id, sym.id)
        resolved++
      }
    }

    logInfo(
      `[TsMorphEnhancer] Resolved ${resolved}/${unresolved.length} call sites`,
    )
  }

  /** Refreshes the source file at the specified absolute path from the file system. */
  override refreshFile(absPath: string): void {
    if (!this.project) return
    const sf = this.project.getSourceFile(absPath)
    if (sf) sf.refreshFromFileSystemSync()
  }

  /** Searches upwards from the current directory through up to five parent levels for a TypeScript configuration file and returns its path if found. */
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

  /** Retrieves an existing source file or adds it to the project from the specified absolute path. */
  private getSourceFile(absPath: string) {
    if (!this.project) return null
    return (
      this.project.getSourceFile(absPath) ??
      this.project.addSourceFileAtPath(absPath)
    )
  }

  /** Resolves the definition location for a function call at the specified file path, line, and column. */
  private resolveCallSite(
    absFilePath: string,
    callLine: number,
    callColumn: number,
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

      const callee = callExpr.getExpression()
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

  /** Retrieves the parameter and return type information for a callable node at the specified file location. */
  private getSymbolSignature(
    absFilePath: string,
    line: number,
    column: number,
  ): ResolvedSignature | null {
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
}
