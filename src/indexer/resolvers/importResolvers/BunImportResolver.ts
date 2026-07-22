import {
  ImportKind,
  type EdgeKind,
  type ImportResolutionResult,
  ResolutionSource,
  ResolvedKind,
} from 'src/database/schemas'
import type { ImportResolver } from './ImportResolver'
import type { LanguageConfig } from 'src/config/types'
import { AppStateManager } from 'src/state'
import { resolvePath } from 'src/utils/paths'
import { dirname, relative, resolve } from 'path'
import { logError } from 'src/utils/logger'

/** A utility class to resolve module import paths using the Bun JavaScript runtime. It handles both built-in modules (like bun:) and external dependencies, providing detailed resolution information including confidence levels and source tracking. */
export class BunImportResolver implements ImportResolver {
  private projectRoot: string
  private langConfig?: LanguageConfig
  private builtInResolvedKinds: string[] = ['bun:', 'node:', 'deno:']

  /** Initializes a new instance of the resolver with the specified programming language, setting up project root and language-specific configurations. */
  constructor(language: string) {
    this.projectRoot =
      AppStateManager.getInstance().getItem('root') ?? process.cwd()
    this.langConfig =
      AppStateManager.getInstance().getItem('config')?.languages?.[language]
  }

  /** Resolve a module name to a concrete file path, handling both built-in modules and external dependencies, and returning detailed resolution information. */
  resolve(
    moduleName: string,
    containingFile: string,
    importedNames: string[],
    importKind: ImportKind,
    edgeKind: EdgeKind,
  ): ImportResolutionResult | null {
    if (
      this.builtInResolvedKinds.some((prefix) => moduleName.startsWith(prefix))
    ) {
      return {
        importedNames,
        importKind,
        edgeKind,
        sourceModule: moduleName,
        resolutionSource: ResolutionSource.Bun,
        isExternal: true,
        isRuntimeDependency: importKind !== ImportKind.TypeOnly,
        confidence: 100,
        resolvedKind: ResolvedKind.BuiltIn,
        resolvedPath: moduleName,
        reason: null,
      }
    }

    const from = resolve(this.projectRoot, containingFile)
    const resolvedModuleName = moduleName.startsWith('.')
      ? resolvePath(moduleName, dirname(from))
      : moduleName

    try {
      const resolved = Bun.resolveSync(resolvedModuleName, from)
      const resolvedPath = relative(this.projectRoot, resolved)
      const isExternal = this.isExternal(resolved)
      return {
        importedNames,
        importKind,
        edgeKind,
        sourceModule: this.isPathLike(resolvedModuleName)
          ? relative(this.projectRoot, resolvedModuleName)
          : resolvedModuleName,
        resolutionSource: ResolutionSource.Bun,
        isExternal: isExternal,
        isRuntimeDependency: importKind !== ImportKind.TypeOnly,
        confidence: 100,
        resolvedKind: this.getResolvedKind(resolved, isExternal),
        resolvedPath: resolvedPath,
        reason: null,
      }
    } catch (error) {
      logError(
        `Error resolving module '${resolvedModuleName}' from '${containingFile}':`,
        error,
      )
      return {
        importedNames,
        importKind,
        edgeKind,
        sourceModule: resolvedModuleName,
        resolutionSource: ResolutionSource.Unresolved,
        isExternal: false,
        isRuntimeDependency: importKind !== ImportKind.TypeOnly,
        confidence: 0,
        resolvedKind: ResolvedKind.Unresolved,
        resolvedPath: null,
        reason: `Error resolving module '${resolvedModuleName}' from '${containingFile}': ${error}`,
      }
    }
  }

  /** Determines if a resolved path is external by checking if it resides outside the project root or within node_modules. */
  private isExternal(resolvedPath: string): boolean {
    return (
      resolvedPath.includes('/node_modules/') ||
      !resolvedPath.startsWith(this.projectRoot)
    )
  }

  /** Determines the kind of a resolved resource based on its path and whether it is external. */
  private getResolvedKind(
    resolvedPath: string,
    isExternal: boolean,
  ): ResolvedKind {
    if (resolvedPath.endsWith('.d.ts')) {
      return ResolvedKind.Declaration
    }

    const assetExtensions =
      this.langConfig?.import_resolution?.asset_extensions ?? []
    if (assetExtensions.some((ext) => resolvedPath.endsWith(ext))) {
      return ResolvedKind.Asset
    }

    if (
      this.builtInResolvedKinds.some((prefix) =>
        resolvedPath.startsWith(prefix),
      )
    ) {
      return ResolvedKind.BuiltIn
    }

    if (isExternal) {
      return ResolvedKind.Package
    }

    if (resolvedPath.startsWith(this.projectRoot)) {
      return ResolvedKind.Source
    }

    return ResolvedKind.Unresolved
  }

  /** Checks if a string is formatted like a valid path. This includes relative paths (./, ../), absolute paths (/...), and standard filesystem-style paths. */
  private isPathLike(moduleName: string): boolean {
    // should match relative paths (./, ../), absolute paths (/) and paths like src/module.ts
    return (
      moduleName.startsWith('./') ||
      moduleName.startsWith('../') ||
      moduleName.startsWith('/') ||
      /^(?:[\w\-.]+\/)+[\w\-.]+$/.test(moduleName)
    )
  }
}
