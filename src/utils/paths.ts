import { fileURLToPath } from 'bun'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve, relative } from 'path'
import { AppStateManager } from 'src/state'

/** "Resolves a given path by converting relative and tilde-based paths to absolute paths." */
export const resolvePath = (inputPath: string, fromDir?: string): string => {
  let resolvedPath = inputPath
  if (inputPath.startsWith('~/')) {
    resolvedPath = inputPath.replace('~', homedir())
  }

  if (isAbsolute(resolvedPath)) {
    return resolvedPath
  }

  const root = AppStateManager.getInstance().getItem('root')
  const baseDir = fromDir || root || resolve(import.meta.dir, '../../')
  resolvedPath = resolve(baseDir, resolvedPath)
  return resolvedPath
}

/** "Resolves the absolute path of an imported module based on its import path and file location." */
export const resolveImportedModulePath = (
  importPath: string,
  filePath: string,
  extension: string,
  directoryIndex: string,
): string => {
  const fileDir = dirname(filePath)

  const root = AppStateManager.getInstance().getItem('root')
  const baseDir = root || resolve(import.meta.dir, '../../')

  if (importPath.startsWith('.')) {
    const absPath = resolve(baseDir, fileDir, importPath)
    const relativeImpPath = relative(baseDir, absPath)

    const pathStats = statSync(absPath, { throwIfNoEntry: false })
    if (pathStats?.isDirectory()) {
      return `${relativeImpPath}/${directoryIndex}`
    }

    if (relativeImpPath.endsWith(extension)) {
      return relativeImpPath
    }

    return `${relativeImpPath}${extension}`
  } else {
    // For non-relative imports, we resolve to the absolute path and then slice off the root
    try {
      const resolved = fileURLToPath(import.meta.resolve(importPath))
      const root = AppStateManager.getInstance().getItem('root')
      const baseDir = root || resolve(import.meta.dir, '../../')

      if (resolved.startsWith(baseDir)) {
        return resolved.slice(baseDir.length).replace(/^[/\\]/, '')
      }

      return resolved
    } catch {
      return importPath
    }
  }
}
