import { Glob } from 'bun'
import { AppStateManager } from 'src/state'
import { join, isAbsolute, relative } from 'path'
import { existsSync, statSync } from 'node:fs'
import { logDebug } from './logger'

type PATHTYPE = 'file' | 'directory' | 'other'
export type GlobData = {
  glob: Glob
  isNegated: boolean
  negativeOverrides?: Map<string, Glob>
}

/** Generates a map of glob patterns to their corresponding GlobData based on the provided test file patterns in the configuration. */
export function getTestFileGlobs(): Map<string, GlobData> {
  const config = AppStateManager.getInstance().getItem('config')
  if (!config) {
    throw new Error('Config not found in AppStateManager')
  }

  return generateGlobData(config.testFilePatterns)
}

/** Generates a map of glob patterns to their corresponding GlobData based on the provided entry point patterns in the configuration. */
export function getEntryPointGlobs(): Map<string, GlobData> {
  const config = AppStateManager.getInstance().getItem('config')
  if (!config) {
    throw new Error('Config not found in AppStateManager')
  }

  return generateGlobData(config.entryPointPatterns)
}

/** Generates a map of glob patterns to their corresponding GlobData based on the provided exclude generation patterns in the configuration. */
export function getExcludeDocstringGenerationGlobs(): Map<string, GlobData> {
  const config = AppStateManager.getInstance().getItem('config')
  if (!config) {
    throw new Error('Config not found in AppStateManager')
  }

  return generateGlobData(
    config.docstring_generation?.exclude_generation_patterns ?? [],
  )
}

/** Links negated glob patterns to their corresponding positive patterns in the provided map. */
export function linkNegatedGlobs(
  existingMap: Map<string, GlobData>,
): Map<string, GlobData> {
  const negatedPatterns = Array.from(
    existingMap.entries().map(([pattern, { isNegated }]) => {
      return isNegated ? pattern : null
    }),
  ).filter((pattern) => pattern !== null)

  existingMap.forEach((value, pattern) => {
    if (value.isNegated) {
      return
    }

    const relatedNegated = negatedPatterns.filter(
      (negPattern) => value.glob.match(negPattern) && negPattern !== pattern,
    )

    if (relatedNegated.length > 0) {
      value.negativeOverrides =
        value.negativeOverrides || (new Map() as Map<string, Glob>)
      relatedNegated.forEach((negPattern) => {
        value.negativeOverrides!.set(
          negPattern,
          existingMap.get(negPattern)!.glob,
        )
      })
    }
  })

  for (const negPattern of negatedPatterns) {
    existingMap.delete(negPattern)
  }

  return existingMap
}

/** Generates a map of glob patterns to their corresponding GlobData based on the provided patterns and optional subtree path. */
export function generateGlobData(
  patterns: string[],
  subtreePath?: string,
): Map<string, GlobData> {
  const globDataMap = new Map<string, GlobData>()
  for (const pattern of patterns) {
    const pd = globifyPattern(pattern, subtreePath)
    if (!pd || pd.length === 0) {
      continue
    }

    for (const { pattern: globPattern, isNegated } of pd) {
      const glob = new Glob(globPattern)
      globDataMap.set(globPattern, { glob, isNegated })
    }
  }

  return linkNegatedGlobs(globDataMap)
}

/** Globifies the given pattern based on its type (file, directory, or other) and returns the corresponding glob pattern. */
export function globifyPattern(
  pattern: string,
  subtreePath?: string,
): Array<
  Omit<GlobData, 'glob'> & {
    pattern: string
  }
> {
  const root = AppStateManager.getInstance().getItem('root')
  if (!root) {
    throw new Error('Root directory should be set')
  }

  let globifiedPattern = pattern
  let isNegated = false
  let hasLeadingSlash = false

  if (pattern.startsWith('!')) {
    globifiedPattern = pattern.slice(1)
    isNegated = true
  }

  if (pattern.startsWith('/')) {
    // If the pattern starts with a slash, it's relative to the root directory in gitignore instead of system root
    globifiedPattern = pattern.slice(1)
    hasLeadingSlash = true
  }

  const isGlobified =
    globifiedPattern.includes('*') ||
    globifiedPattern.includes('?') ||
    new RegExp(/[[\]{}]/).test(globifiedPattern)

  let pathType: PATHTYPE | null = !isGlobified
    ? getPathType(join(root, subtreePath ?? '', globifiedPattern))
    : 'other'

  if (!pathType) {
    return []
  }

  const results: Array<Omit<GlobData, 'glob'> & { pattern: string }> = []

  const prependSegment = hasLeadingSlash ? '' : '**/'
  switch (pathType) {
    case 'file':
      globifiedPattern = globifiedPattern.startsWith('**/')
        ? globifiedPattern
        : `${prependSegment}${globifiedPattern}`
      results.push({ pattern: globifiedPattern, isNegated })
      break
    case 'directory':
      globifiedPattern = globifiedPattern.endsWith('/')
        ? `${globifiedPattern}**/*`
        : `${globifiedPattern}/**/*`
      globifiedPattern = globifiedPattern.startsWith('**/')
        ? globifiedPattern
        : `${prependSegment}${globifiedPattern}`
      results.push({
        pattern: globifiedPattern.replace(/\/\*\*\/\*$/, ''),
        isNegated,
      })
      results.push({ pattern: globifiedPattern, isNegated })
      break
    case 'other':
      globifiedPattern = globifiedPattern.startsWith('**/')
        ? globifiedPattern
        : `${prependSegment}${globifiedPattern}`
      results.push({ pattern: globifiedPattern, isNegated })
      break
  }

  return results
}

/** Determines the type of the given path (file, directory, or other) based on its existence and stats. */
export function getPathType(path: string): PATHTYPE | null {
  const pathExists = existsSync(path)
  if (!pathExists) {
    return null
  }

  const stats = statSync(path)

  if (stats.isDirectory()) {
    return 'directory'
  }

  if (stats.isFile()) {
    return 'file'
  }

  return 'other'
}

/** Determines if a provided path matches any of the configured glob patterns, taking into account any negative overrides. */
export function doesPathMatch(
  globs: Map<string, GlobData>,
  relOrAbsPath: string,
): boolean {
  const isAbs = isAbsolute(relOrAbsPath)
  let relPath = relOrAbsPath
  if (isAbs) {
    const root = AppStateManager.getInstance().getItem('root')
    if (!root) {
      throw new Error('Root directory should be set')
    }
    relPath = relative(root, relOrAbsPath)
  }

  let matched = false

  for (const [pattern, { glob, negativeOverrides }] of globs.entries()) {
    const matchState = glob.match(relPath)
    if (matchState) {
      matched = true
      logDebug(`Path ${relPath} matches pattern: ${pattern}`)
      if (negativeOverrides) {
        for (const [negPattern, negGlob] of negativeOverrides.entries()) {
          if (negGlob.match(relPath)) {
            logDebug(`Path ${relPath} is negated by pattern: ${negPattern}`)
            matched = false
            break
          }
        }
      }
      break
    }
  }
  return matched
}
