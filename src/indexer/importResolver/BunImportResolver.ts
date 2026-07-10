import {
  type ImportKind,
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

export class BunImportResolver implements ImportResolver {
  private projectRoot: string
  private langConfig?: LanguageConfig
  private builtInResolvedKinds: string[] = ['bun:', 'node:', 'deno:']

  constructor(private readonly language: string) {
    this.projectRoot =
      AppStateManager.getInstance().getItem('root') ?? process.cwd()
    this.langConfig =
      AppStateManager.getInstance().getItem('config')?.languages?.[language]
  }

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
        isRuntimeDependency: true,
        confidence: 1,
        resolvedKind: ResolvedKind.BuiltIn,
        resolvedPath: moduleName,
        reason: null,
      }
    }

    const from = resolve(containingFile, this.projectRoot)
    const resolvedModuleName = moduleName.startsWith('.')
      ? resolvePath(moduleName, dirname(containingFile))
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
        isRuntimeDependency: false,
        confidence: 1,
        resolvedKind: this.getResolvedKind(resolved, isExternal),
        resolvedPath: resolvedPath,
        reason: null,
      }
    } catch (error) {
      console.error(
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
        isRuntimeDependency: false,
        confidence: 0,
        resolvedKind: ResolvedKind.Unresolved,
        resolvedPath: null,
        reason: `Error resolving module '${resolvedModuleName}' from '${containingFile}': ${error}`,
      }
    }
  }

  private isExternal(resolvedPath: string): boolean {
    return (
      resolvedPath.includes('/node_modules/') ||
      !resolvedPath.startsWith(this.projectRoot)
    )
  }

  private getResolvedKind(
    resolvedPath: string,
    isExternal: boolean,
  ): ResolvedKind {
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

    if (resolvedPath.endsWith('.d.ts')) {
      return ResolvedKind.Declaration
    }

    const assetExtensions =
      this.langConfig?.import_resolution?.asset_extensions ?? []
    if (assetExtensions.some((ext) => resolvedPath.endsWith(ext))) {
      return ResolvedKind.Asset
    }

    return ResolvedKind.Unresolved
  }

  private isPathLike(moduleName: string): boolean {
    // should match relative paths (./, ../), absolute paths (/) and paths like src/module.ts
    return (
      moduleName.startsWith('./') ||
      moduleName.startsWith('../') ||
      moduleName.startsWith('/') ||
      /^[a-zA-Z0-9_\-./]+$/.test(moduleName)
    )
  }
}
