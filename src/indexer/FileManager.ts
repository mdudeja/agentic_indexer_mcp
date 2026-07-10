import { join, isAbsolute, relative, dirname } from 'path'
import { readdir } from 'node:fs/promises'
import type { IndexerConfig } from 'src/config/types'
import { AppStateManager } from 'src/state'
import { statSync } from 'node:fs'
import { logDebug } from 'src/utils/logger'
import {
  generateGlobData,
  linkNegatedGlobs,
  type GlobData,
} from 'src/utils/pathGlobs'
import { resolveWorkspacePath } from 'src/utils/paths'

/** A utility class for managing file operations, including handling ignore patterns from configuration and .gitignore files to determine which files should be excluded. */
export class FileManager {
  private config?: IndexerConfig
  private static instance?: FileManager
  private ignoreGlobs: Map<string, GlobData> = new Map()

  private readonly trailingNecessaryWSRegex = /\\\s+$/

  /** Initializes the FileManager instance by setting up default configuration values if none are retrieved from state storage. */
  private constructor() {
    this.config = AppStateManager.getInstance().getItem('config') ?? {
      enabled: false,
      languages: {},
      ignore_patterns: [],
      testFilePatterns: [],
      extnToLangMap: {},
      agent_config_candidates: [],
      entryPointPatterns: [],
    }
  }

  /** Returns the singleton instance of FileManager to manage file operations consistently across the application. */
  public static async getInstance(): Promise<FileManager> {
    if (!FileManager.instance) {
      FileManager.instance = new FileManager()
      await FileManager.instance.populateIgnoreGlobs()
      FileManager.instance.ignoreGlobs = linkNegatedGlobs(
        FileManager.instance.ignoreGlobs,
      )
    }
    return FileManager.instance
  }

  /** Finds all `.gitignore` files in the specified directory and its subdirectories, returning their absolute paths. */
  async findGitignoreFiles(
    dir: string,
    foundFiles: string[] = [],
  ): Promise<string[]> {
    const files = await readdir(dir)

    try {
      for (const file of files) {
        const absPath = resolveWorkspacePath(join(dir, file))
        const stats = statSync(absPath)

        if (stats.isDirectory()) {
          await this.findGitignoreFiles(absPath, foundFiles)
        } else if (file === '.gitignore') {
          foundFiles.push(absPath)
        }
      }
      return foundFiles
    } catch (error) {
      logDebug(`Error while reading directory ${dir}: ${error}`)
      return []
    }
  }

  /** Checks if the given relative path matches any of the ignore globs, indicating that the file should be ignored. */
  public isPathIgnored(relOrAbsPath: string): boolean {
    const isAbs = isAbsolute(relOrAbsPath)
    let relPath = relOrAbsPath
    if (isAbs) {
      const root = AppStateManager.getInstance().getItem('root')
      if (!root) {
        throw new Error('Root directory should be set')
      }
      relPath = relative(root, relOrAbsPath)
    }

    let ignored = false

    for (const [
      pattern,
      { glob, negativeOverrides },
    ] of this.ignoreGlobs.entries()) {
      const matchState = glob.match(relPath)
      if (matchState) {
        ignored = true
        logDebug(`Path ${relPath} is ignored due to pattern: ${pattern}`)
        if (negativeOverrides) {
          for (const [negPattern, negGlob] of negativeOverrides.entries()) {
            if (negGlob.match(relPath)) {
              logDebug(
                `Path ${relPath} is NOT ignored due to negated pattern: ${negPattern}`,
              )
              ignored = false
              break
            }
          }
        }
        break
      }
    }

    return ignored
  }

  /** Retrieves the map of ignore glob patterns used for exclusion purposes. */
  public getIgnoreGlobs(): Map<string, GlobData> {
    return this.ignoreGlobs
  }

  /** Resets the FileManager instance, clearing the ignore globs and allowing for reinitialization. */
  public reset() {
    this.ignoreGlobs.clear()
    FileManager.instance = undefined
  }

  /** Populates the ignore globs based on the configuration and `.gitignore` files. */
  private async populateIgnoreGlobs() {
    const root = AppStateManager.getInstance().getItem('root')

    if (!root) {
      throw new Error('Root directory should be set')
    }

    this.ignoreGlobs = generateGlobData(this.config?.ignore_patterns ?? [])

    const includeGitIgnored =
      AppStateManager.getInstance().getItem('includeGitIgnored') ?? false

    if (includeGitIgnored) {
      return
    }

    // get all gitignore files from the workspace and add their patterns to the ignore list
    const gitignoreFiles = await this.findGitignoreFiles(root)

    for (const gitignoreFile of gitignoreFiles) {
      if (this.isPathIgnored(gitignoreFile)) {
        continue
      }

      const subtreePath = relative(root, dirname(gitignoreFile))
      const content = await Bun.file(gitignoreFile).text()
      const patterns = content
        .split('\n')
        .map((line) => this.removeWhitespaces(line))
        .filter((line) => line && !line.startsWith('#'))

      const globData = generateGlobData(patterns, subtreePath)
      for (const [pattern, data] of globData.entries()) {
        this.ignoreGlobs.set(pattern, data)
      }
    }
  }

  /** Removes unnecessary leading and trailing whitespaces from the given pattern, while preserving necessary trailing whitespaces. */
  private removeWhitespaces(pattern: string): string {
    let withoutTrailing = pattern
    if (!this.trailingNecessaryWSRegex.test(pattern)) {
      withoutTrailing = pattern.replace(/\s+$/, '')
    } else {
      withoutTrailing = pattern.replace(/\\(\s+)$/, '$1')
    }

    return withoutTrailing.replace(/^\s+/, '')
  }
}
