import {
  ResolutionSource,
  ResolvedKind,
  type EdgeKind,
  type ImportKind,
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

export class PythonImportResolver implements ImportResolver {
  private projectRoot: string
  private langConfig?: LanguageConfig
  private pythonConfig?: PythonImportResolutionConfig
  private findSpecScriptPath: string | null = null

  constructor(private readonly language: string) {
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

  private resolveStaticImport(
    moduleName: string,
    containingFile: string,
    importedNames: string[],
    importKind: ImportKind,
    edgeKind: EdgeKind,
  ): ImportResolutionResult | null {
    const sourceRoots = this.pythonConfig?.source_roots ?? []
    let targetPath: string = moduleName
    if (moduleName.startsWith('.')) {
      const startDotCount = moduleName.match(/^\.+/)![0].length
      if (startDotCount === 1) {
        targetPath = moduleName.slice(1)
      } else {
        const levelsUp =
          startDotCount % 2 === 0 ? startDotCount / 2 : (startDotCount - 1) / 2
        targetPath = `${'../'.repeat(levelsUp)}${moduleName.slice(startDotCount)}`
        targetPath = join(dirname(containingFile), targetPath)
      }
    }

    targetPath = targetPath.replaceAll('.', '/')

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

    return {
      sourceModule: moduleName,
      edgeKind,
      importedNames,
      importKind,
      resolvedPath: result.origin,
      resolutionSource: ResolutionSource.PythonImportlib,
      isExternal: false,
      confidence: 1,
      reason: null,
      resolvedKind: result.kind,
      isRuntimeDependency: false,
    }
  }

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
