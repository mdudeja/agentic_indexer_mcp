import {
  EdgeKind,
  type ImportKind,
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

export class TypescriptImportResolver implements ImportResolver {
  private projectRoot: string
  private langConfig?: LanguageConfig
  private allTsConfigFiles: Set<string> = new Set()
  private compilerOptionsByConfigPath: Map<string, ts.ParsedCommandLine> =
    new Map()
  private cacheByConfigPath: Map<string, ts.ModuleResolutionCache> = new Map()
  private host: ts.ModuleResolutionHost
  private builtInResolvedKinds: string[] = ['bun:', 'node:', 'deno:']

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
        isRuntimeDependency: true,
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
      isRuntimeDependency: false,
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

    this.compilerOptionsByConfigPath.set(
      configPath,
      ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        dirname(configFilePath),
      ),
    )
    this.cacheByConfigPath.set(
      configPath,
      ts.createModuleResolutionCache(
        this.projectRoot,
        ts.sys.useCaseSensitiveFileNames ? (s) => s : (s) => s.toLowerCase(),
        configFile.config.compilerOptions,
      ),
    )

    return configPath
  }

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

  private enhanceResolutionResult(
    result: Partial<ImportResolutionResult>,
  ): ImportResolutionResult {
    if (!result.resolvedPath) {
      result.reason = 'Module could not be resolved by TypeScript'
      result.resolvedKind = ResolvedKind.Unresolved
      result.confidence = 0
    } else {
      if (result.resolvedPath.endsWith('.d.ts')) {
        result.resolvedKind = ResolvedKind.Declaration
      } else if (
        this.builtInResolvedKinds.some((prefix) =>
          result.sourceModule?.startsWith(prefix),
        )
      ) {
        result.resolvedKind = ResolvedKind.BuiltIn
      } else if (result.isExternal) {
        result.resolvedKind = ResolvedKind.Package
      } else {
        result.resolvedKind = ResolvedKind.Source
      }

      const assetExtensions =
        this.langConfig?.import_resolution?.asset_extensions

      if (assetExtensions && assetExtensions.length > 0) {
        const ext = result.sourceModule?.split('.').pop()?.toLowerCase()
        if (ext && assetExtensions.includes(ext)) {
          result.resolvedKind = ResolvedKind.Asset
        }
      }
    }

    return result as ImportResolutionResult
  }
}
