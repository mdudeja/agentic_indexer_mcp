import { join, relative } from 'path'
import { readdir, stat } from 'node:fs/promises'
import { TreeSitterIndexer } from './TreeSitterIndexer.ts'
import type { IndexerDB } from '../database/IndexerDB.ts'
import type { IndexerConfig } from 'src/config/types.ts'
import { AppStateManager } from 'src/state/index.ts'
import { logError, logInfo } from 'src/utils/logger.ts'
export interface IndexPipelineOptions {
  cwd: string
  store: IndexerDB
  includeGitIgnored: boolean
}

export class IndexPipeline {
  private indexer: TreeSitterIndexer
  private config: IndexerConfig
  private ignoreRegexPatterns: Set<RegExp> = new Set()

  constructor(private options: IndexPipelineOptions) {
    this.indexer = new TreeSitterIndexer()
    this.config = AppStateManager.getInstance().getItem('config') ?? {
      enabled: false,
      languages: {},
      ignore_patterns: [],
      extnToLangMap: {},
    }
  }

  async findGitignoreFiles(
    dir: string,
    foundFiles: string[] = [],
  ): Promise<string[]> {
    const files = await readdir(dir)

    for (const file of files) {
      const absPath = join(dir, file)
      const stats = await stat(absPath)

      if (stats.isDirectory()) {
        await this.findGitignoreFiles(absPath, foundFiles)
      } else if (file === '.gitignore') {
        foundFiles.push(absPath)
      }
    }

    return foundFiles
  }

  async populateIgnorePatterns() {
    for (const pattern of this.config.ignore_patterns) {
      const regex = new RegExp(
        pattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*'),
      )
      this.ignoreRegexPatterns.add(regex)
    }

    if (this.options.includeGitIgnored) {
      return
    }

    // get all gitignore files from the workspace and add their patterns to the ignore list
    const gitignoreFiles = await this.findGitignoreFiles(this.options.cwd)

    for (const gitignoreFile of gitignoreFiles) {
      const content = await Bun.file(gitignoreFile).text()
      const patterns = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))

      for (const pattern of patterns) {
        const regex = new RegExp(
          pattern
            .split('*')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*'),
        )
        this.ignoreRegexPatterns.add(regex)
      }
    }
  }

  async run() {
    logInfo(`[Indexer] Starting index pipeline in ${this.options.cwd}...`)
    if (
      this.config.ignore_patterns.length > 0 &&
      this.ignoreRegexPatterns.size === 0
    ) {
      await this.populateIgnorePatterns()
    }

    const files = await this.findFiles(this.options.cwd)
    const processedFiles: string[] = []

    for (const absPath of files) {
      const relPath = await this.runOnFile(absPath)
      if (relPath) processedFiles.push(relPath)
    }

    logInfo(
      `[Indexer] Indexed ${processedFiles.length} files. Total found: ${files.length}`,
    )
  }

  // Returns the relative path if the file was actually indexed, null if skipped (cache hit).
  async runOnFile(absPath: string): Promise<string | null> {
    const relPath = relative(this.options.cwd, absPath)
    if (this.config.ignore_patterns.some((p) => relPath.includes(p)))
      return null

    const ext = absPath.split('.').pop() || ''

    try {
      const content = await Bun.file(absPath).text()
      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(content)
      const hash = hasher.digest('hex')

      const currentHash = await this.options.store.getFileHash(relPath)
      if (currentHash === hash) return null

      const parsed = await this.indexer.parse(content, ext, relPath)
      if (!parsed) return null

      await this.options.store.upsertFile({
        path: relPath,
        hash,
        language: this.config.extnToLangMap[ext] || 'unknown',
      })
      await this.options.store.upsertSymbols(parsed.symbols)
      await this.options.store.upsertCalls(parsed.calls)
      await this.options.store.upsertImports(parsed.imports)
      logInfo(
        `[Indexer] Indexed ${relPath} with ${parsed.symbols.length} symbols, ${parsed.imports.length} imports, and ${parsed.calls.length} calls.`,
      )
      return relPath
    } catch (e) {
      logError(`[Indexer] Failed to index ${relPath}:`, e)
      return null
    }
  }

  private async findFiles(
    dir: string,
    fileList: string[] = [],
  ): Promise<string[]> {
    const files = await readdir(dir)

    for (const file of files) {
      const relPath = relative(this.options.cwd, join(dir, file))
      if ([...this.ignoreRegexPatterns].some((regex) => regex.test(relPath))) {
        continue
      }

      const absPath = join(dir, file)
      const stats = await stat(absPath)

      if (stats.isDirectory()) {
        await this.findFiles(absPath, fileList)
      } else {
        fileList.push(absPath)
      }
    }

    return fileList
  }
}
