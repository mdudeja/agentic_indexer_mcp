import {
  ImportKind,
  ResolutionSource,
  ResolvedKind,
  type EdgeKind,
  type ImportResolutionResult,
} from 'src/database/schemas'
import type { ImportResolver } from './ImportResolver'
import type {
  LanguageConfig,
  PythonImportResolutionConfig,
} from 'src/config/types'
import { AppStateManager } from 'src/state'
import { dirname, join, relative } from 'path'
import { existsSync } from 'fs'

/** Provides import resolution functionality for Python code within the application. */
export class PythonImportResolver implements ImportResolver {
  private projectRoot: string
  private langConfig?: LanguageConfig
  private pythonConfig?: PythonImportResolutionConfig
  private findSpecScriptPath: string | null = null

  /** Initializes a new instance of the PythonImportResolver class with configuration specific to the provided programming language. */
  constructor(language: string) {
    this.projectRoot =
      AppStateManager.getInstance().getItem('root') ?? process.cwd()
    this.langConfig =
      AppStateManager.getInstance().getItem('config')?.languages?.[language]

    if (!this.langConfig || !this.langConfig.import_resolution?.python) {
      throw new Error(
        `Import resolution configuration not found for language: ${language}`,
      )
    }

    this.pythonConfig = this.langConfig.import_resolution.python
    this.findSpecScriptPath = join(
      import.meta.dir,
      'helpers',
      'python_find_spec.py',
    )
  }

  /** Attempts to resolve an import by first checking for static resolution. If static resolution fails and Importlib is enabled, it falls back to resolving using Importlib. Returns the result of the successful resolution or null if unresolved. */
  resolve(
    moduleName: string,
    containingFile: string,
    importedNames: string[],
    importKind: ImportKind,
    edgeKind: EdgeKind,
  ): ImportResolutionResult | null {
    const staticResult = this.resolveStaticImport(
      moduleName,
      containingFile,
      importedNames,
      importKind,
      edgeKind,
    )

    if (staticResult) {
      return staticResult
    }

    if (!this.pythonConfig?.use_importlib) {
      return this.getUnresolvedResult(
        moduleName,
        edgeKind,
        importedNames,
        importKind,
        'Importlib is disabled in the configuration',
      )
    }

    const importlibResult = this.resolveViaImportlib(
      moduleName,
      importedNames,
      importKind,
      edgeKind,
    )

    return importlibResult
  }

  /** Resolves a static import by determining the target module or file location based on the provided parameters. */
  private resolveStaticImport(
    moduleName: string,
    containingFile: string,
    importedNames: string[],
    importKind: ImportKind,
    edgeKind: EdgeKind,
  ): ImportResolutionResult | null {
    const sourceRoots = this.pythonConfig?.source_roots ?? []
    let targetPath = this.generateTargetPathForStaticImport(
      moduleName,
      containingFile,
    )

    let foundFile: string | null = null
    for (const sourceRoot of [dirname(containingFile), ...sourceRoots]) {
      const fullPath = join(this.projectRoot, sourceRoot, targetPath)
      const fileCandidates = [`${fullPath}.py`, join(fullPath, '__init__.py')]
      for (const candidate of fileCandidates) {
        if (existsSync(candidate)) {
          foundFile = candidate
          break
        }
      }
      if (foundFile) {
        break
      }
    }

    if (!foundFile) {
      return null
    }

    return {
      sourceModule: moduleName.replace(/^\.+/, ''),
      edgeKind,
      importedNames,
      importKind,
      resolvedPath: relative(this.projectRoot, foundFile),
      resolutionSource: ResolutionSource.PythonStatic,
      isExternal: false,
      confidence: 1,
      reason: null,
      resolvedKind: ResolvedKind.Source,
      isRuntimeDependency: false,
    }
  }

  /** Generates the target path for a static import based on the module name and containing file. */
  private generateTargetPathForStaticImport(
    moduleName: string,
    containingFile: string,
  ): string {
    const startDotCount = moduleName.match(/^\.+/)?.[0].length ?? 0
    const levelsUp =
      startDotCount % 2 === 0 ? startDotCount / 2 : (startDotCount - 1) / 2
    let targetPath: string = moduleName
      .slice(startDotCount)
      .replaceAll('.', '/')

    if (levelsUp > 0) {
      targetPath = `${'../'.repeat(levelsUp)}${targetPath}`
      targetPath = join(dirname(containingFile), targetPath)
    }

    return targetPath
  }

  /** Resolves module paths and kinds via Python's importlib by leveraging the find_spec python file. */
  private resolveViaImportlib(
    moduleName: string,
    importedNames: string[],
    importKind: ImportKind,
    edgeKind: EdgeKind,
  ): ImportResolutionResult {
    const pythonPath = this.pythonConfig?.python_path ?? 'python'
    if (!this.findSpecScriptPath) {
      return this.getUnresolvedResult(
        moduleName,
        edgeKind,
        importedNames,
        importKind,
        'Could not find python_find_spec.py script',
      )
    }

    const proc = Bun.spawnSync({
      cmd: [pythonPath, this.findSpecScriptPath, moduleName],
      cwd: this.projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (!proc.success) {
      return this.getUnresolvedResult(
        moduleName,
        edgeKind,
        importedNames,
        importKind,
        `python_find_spec.py script failed: ${proc.stderr.toString()}`,
      )
    }

    const result = JSON.parse(proc.stdout.toString())
    if (!result.ok) {
      return this.getUnresolvedResult(
        moduleName,
        edgeKind,
        importedNames,
        importKind,
        `Could not find module: ${moduleName}`,
      )
    }

    const isExternal =
      result.kind === ResolvedKind.Package ||
      result.kind === ResolvedKind.BuiltIn ||
      result.kind === ResolvedKind.StdLib

    return {
      sourceModule: moduleName,
      edgeKind,
      importedNames,
      importKind,
      resolvedPath: result.origin,
      resolutionSource: ResolutionSource.PythonImportlib,
      isExternal,
      confidence: 1,
      reason: null,
      resolvedKind: result.kind,
      isRuntimeDependency: importKind !== ImportKind.TypeOnly,
    }
  }

  /** Creates an unresolved import resolution result object with specified parameters. */
  private getUnresolvedResult(
    moduleName: string,
    edgeKind: EdgeKind,
    importedNames: string[],
    importKind: ImportKind,
    errorMessage: string,
  ): ImportResolutionResult {
    return {
      sourceModule: moduleName,
      edgeKind,
      importedNames,
      importKind,
      resolvedPath: null,
      resolutionSource: ResolutionSource.Unresolved,
      isExternal: false,
      confidence: 0,
      reason: errorMessage,
      resolvedKind: ResolvedKind.Unresolved,
      isRuntimeDependency: false,
    }
  }
}
