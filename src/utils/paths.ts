import { fileURLToPath } from 'bun'
import { homedir } from 'node:os'
import { dirname, relative } from 'node:path'
import { isAbsolute, resolve } from 'path'

/** Resolves a path by expanding home directory aliases and converting relative paths into absolute paths. */
export const resolvePath = (inputPath: string): string => {
  let resolvedPath = inputPath
  if (inputPath.startsWith('~/')) {
    resolvedPath = inputPath.replace('~', homedir())
  }

  if (isAbsolute(resolvedPath)) {
    return resolvedPath
  }

  const baseDir = resolve(import.meta.dir, '../../')
  resolvedPath = resolve(baseDir, resolvedPath)
  return resolvedPath
}

/** Resolves an import path relative to the project's base directory, handling both relative file paths and package identifiers. */
export const resolveImportedModulePath = (
  importPath: string,
  filePath: string,
): string => {
  const baseDir = resolve(import.meta.dir, '../../')
  const fileDir = relative(baseDir, dirname(filePath))

  if (importPath.startsWith('.')) {
    // Relative import
    return relative(baseDir, resolve(fileDir, importPath))
  } else {
    // For non-relative imports, it could be a package or an absolute path. We need to handle both cases.
    try {
      const resolvedModulePath = relative(
        baseDir,
        fileURLToPath(import.meta.resolve(importPath)),
      )
      return resolvedModulePath
    } catch {
      // If it fails, treat it as an absolute path
      return importPath
    }
  }
}
