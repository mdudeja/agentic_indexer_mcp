import {
  EdgeKind,
  ImportKind,
  ResolutionSource,
  ResolvedKind,
  type ImportResolutionResult,
} from 'src/database/schemas'
import type { ImportResolver } from './ImportResolver'
import ts from 'typescript'
import { dirname, normalize, relative, resolve } from 'path'
import { getTsconfigPathGlobsForLanguage } from 'src/utils/pathGlobs'
import { AppStateManager } from 'src/state'
import type { LanguageConfig } from 'src/config/types'
import { resolvePath } from 'src/utils/paths'

/** A class that resolves import paths using TypeScript configuration files and module resolution logic. It determines the location of imported modules based on TypeScript compiler options and file structure, handling both internal and external dependencies. */
export class TypescriptImportResolver implements ImportResolver {
  private projectRoot: string
  private langConfig?: LanguageConfig
  private allTsConfigFiles: Set<string> = new Set()
  private compilerOptionsByConfigPath: Map<string, ts.ParsedCommandLine> =
    new Map()
  private cacheByConfigPath: Map<string, ts.ModuleResolutionCache> = new Map()
  private host: ts.ModuleResolutionHost
  private builtInResolvedKinds: string[] = ['bun:', 'node:', 'deno:']

  /** Initializes a new instance of the TypescriptImportResolver with configuration files for the specified programming language. */
  constructor(private readonly language: string) {
    this.projectRoot =
      AppStateManager.getInstance().getItem('root') ?? process.cwd()
    this.langConfig =
      AppStateManager.getInstance().getItem('config')?.languages?.[language]
    this.host = ts.sys

    const tsConfigGlobs = getTsconfigPathGlobsForLanguage(this.language)

    const tsConfigFiles: Set<string> = new Set()
    for (const [_, globData] of tsConfigGlobs.entries()) {
      let files = Array.from(
        globData.glob.scanSync({
          cwd: this.projectRoot,
          absolute: true,
          onlyFiles: true,
        }),
      )

      if (globData.negativeOverrides && globData.negativeOverrides.size > 0) {
        for (const [
          _,
          overrideGlobData,
        ] of globData.negativeOverrides.entries()) {
          const overriddenFiles = files.filter((file) =>
            overrideGlobData.match(relative(this.projectRoot, file)),
          )
          files = files.filter((file) => !overriddenFiles.includes(file))
        }
      }

      files.forEach((file) => tsConfigFiles.add(file))
    }

    const fileManager = AppStateManager.getInstance().getItem('fileManager')

    if (!fileManager) {
      throw new Error('FileManager instance not found in AppStateManager')
    }

    tsConfigFiles.forEach((configPath) => {
      if (fileManager.isPathIgnored(configPath)) {
        return
      }
      this.allTsConfigFiles.add(configPath)
    })
  }

  /** Resolves a given module name within the context of a specified file, using TypeScript configuration to determine its location and other import-related details. */
  resolve(
    moduleName: string,
    containingFile: string,
    importedNames: string[],
    importKind: ImportKind,
    edgeKind: EdgeKind,
  ): ImportResolutionResult | null {
    const configPath = this.loadTsConfig(containingFile)

    const compilerOptions = this.compilerOptionsByConfigPath.get(configPath)
    const cache = this.cacheByConfigPath.get(configPath)

    if (!compilerOptions || !cache) {
      throw new Error(
        `Compiler options or cache not found for tsconfig: ${configPath}`,
      )
    }

    if (
      this.builtInResolvedKinds.some((prefix) => moduleName.startsWith(prefix))
    ) {
      return {
        sourceModule: moduleName,
        edgeKind,
        resolvedPath: null,
        resolutionSource: ResolutionSource.Typescript,
        isExternal: true,
        confidence: 1,
        reason: null,
        importedNames,
        importKind,
        resolvedKind: ResolvedKind.BuiltIn,
        isRuntimeDependency: importKind !== ImportKind.TypeOnly,
      }
    }

    const resolutionResult = ts.resolveModuleName(
      moduleName,
      resolvePath(containingFile, this.projectRoot),
      compilerOptions.options,
      this.host,
      cache,
    )

    const resolved = resolutionResult.resolvedModule
    let result: Partial<ImportResolutionResult> = {
      importedNames,
      importKind,
      edgeKind,
      isRuntimeDependency: importKind !== ImportKind.TypeOnly,
    }

    if (!resolved) {
      result = {
        ...result,
        sourceModule: moduleName,
        resolutionSource: ResolutionSource.Unresolved,
        isExternal: !moduleName.startsWith('.') && !moduleName.startsWith('/'),
      }
    } else {
      result = {
        ...result,
        sourceModule: moduleName,
        resolvedPath: normalize(
          relative(this.projectRoot, resolved.resolvedFileName),
        ),
        resolutionSource: ResolutionSource.Typescript,
        isExternal: resolved.isExternalLibraryImport ?? false,
        confidence: 1,
        reason: null,
      }
    }
    return this.enhanceResolutionResult(result)
  }

  /** Loads the TypeScript configuration for a given file path by locating the nearest tsconfig.json file and returning its path after validation and caching. */
  private loadTsConfig(containingFile: string): string {
    const configPath = this.findNearestTsConfig(containingFile)

    if (!configPath) {
      throw new Error(`No tsconfig.json found for the file: ${containingFile}`)
    }

    if (this.compilerOptionsByConfigPath.has(configPath)) {
      return configPath
    }

    const configFilePath = resolve(this.projectRoot, configPath)
    const configFile = ts.readConfigFile(configFilePath, ts.sys.readFile)

    if (configFile.error) {
      throw new Error(
        ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
      )
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      dirname(configFilePath),
    )

    this.compilerOptionsByConfigPath.set(configPath, parsed)
    this.cacheByConfigPath.set(
      configPath,
      ts.createModuleResolutionCache(
        this.projectRoot,
        ts.sys.useCaseSensitiveFileNames ? (s) => s : (s) => s.toLowerCase(),
        parsed.options,
      ),
    )

    return configPath
  }

  /** Finds the nearest TypeScript configuration (tsconfig.json) file by searching upward from the specified files directory. */
  private findNearestTsConfig(containingFile: string): string | null {
    let currentDir = normalize(
      relative(this.projectRoot, dirname(containingFile)),
    )
    let matchedPath: string | null = null

    while (currentDir !== '..') {
      const matchingPath = Array.from(this.allTsConfigFiles).find(
        (configPath) =>
          normalize(relative(this.projectRoot, dirname(configPath))) ===
          currentDir,
      )
      if (matchingPath) {
        matchedPath = matchingPath
        break
      }
      currentDir = normalize(dirname(currentDir))
    }

    return matchedPath
  }

  /** Enhances an import resolution result by determining and setting the appropriate kind based on the modules source path and other factors. */
  private enhanceResolutionResult(
    result: Partial<ImportResolutionResult>,
  ): ImportResolutionResult {
    if (!result.resolvedPath) {
      result.reason = 'Module could not be resolved by TypeScript'
      result.resolvedKind = ResolvedKind.Unresolved
      result.confidence = 0
    } else {
      result.resolvedKind = this.getResolvedKind(
        resolve(this.projectRoot, result.resolvedPath),
        result.isExternal ?? false,
      )
    }

    return result as ImportResolutionResult
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
}
