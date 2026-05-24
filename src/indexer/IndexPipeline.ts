import { join, relative } from 'path'
import { readdir, stat } from 'node:fs/promises'
import { TreeSitterIndexer } from './TreeSitterIndexer.ts'
import type { IndexerDB } from '../database/IndexerDB.ts'
import type { IndexerConfig } from 'src/config/types.ts'
import { AppStateManager } from 'src/state/index.ts'
import { logError, logInfo } from 'src/utils/logger.ts'
import type { Enhancer } from './steps/s2_Enhancer.ts'
import { TsMorphEnhancer } from './enhancers/TsMorphEnhancer.ts'
import { DocstringGenerationStep } from './steps/s3_docstring_generator.ts'

const fileTypeToEnhancerMap: Record<string, new (cwd: string) => Enhancer> = {
  ts: TsMorphEnhancer,
  tsx: TsMorphEnhancer,
}

export interface IndexPipelineOptions {
  cwd: string
  store: IndexerDB
  includeGitIgnored: boolean
}

/** Manages the overall indexing process, orchestrating symbol extraction, enhancement, and docstring processing for a project. */
export class IndexPipeline {
  private indexer: TreeSitterIndexer
  private config: IndexerConfig
  private ignoreRegexPatterns: Set<RegExp> = new Set()
  private enhancers: Record<string, Enhancer> = {}

  /** Constructs a new IndexPipeline instance using provided configuration options. Initializes necessary components for indexing operations. */
  constructor(private options: IndexPipelineOptions) {
    this.indexer = new TreeSitterIndexer()
    this.config = AppStateManager.getInstance().getItem('config') ?? {
      enabled: false,
      languages: {},
      ignore_patterns: [],
      extnToLangMap: {},
    }
  }

  /** Finds all `.gitignore` files in the specified directory and its subdirectories, returning their absolute paths. */
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

  /** Populates a set of regular expression patterns based on configured ignore patterns and Gitignore files, enabling file matching for exclusion purposes. */
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

  /** Runs the indexing pipeline, orchestrating symbol extraction, enhancement, and docstring processing for the project. */
  async run() {
    logInfo(`[Indexer] Starting index pipeline in ${this.options.cwd}...`)
    if (
      this.config.ignore_patterns.length > 0 &&
      this.ignoreRegexPatterns.size === 0
    ) {
      await this.populateIgnorePatterns()
    }

    const processedFiles = await this.runSymbolExtractionStep()

    await Bun.sleep(1000) // slight delay to ensure all DB transactions are settled before enhancement

    await this.runEnhancementStep(processedFiles)
    await this.runDocstringStep()
  }

  /** Processes a file at the specified absolute path, checks for changes, parses content, updates store with new data, and returns the relative path if successful. Returns null if the file is ignored or processing fails. */
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

  /** Removes all existing docstrings from the specified store. */
  async removeAllDocstrings(store: IndexerDB): Promise<void> {
    const step = new DocstringGenerationStep(this.options.cwd)
    await step.removeAllDocstrings(store)
  }

  /** Finds all files in the specified directory and its subdirectories, ignoring any files that match specified patterns. Returns an array of file paths. */
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

  /** "Runs a step to extract symbols from source files using Tree-sitter. Processes each file and collects paths of successfully processed files." */
  private async runSymbolExtractionStep(): Promise<string[]> {
    const files = await this.findFiles(this.options.cwd)
    const processedFiles: string[] = []

    logInfo(
      `[Indexer] Running Step 1: Tree-sitter Indexing on ${files.length} files...`,
    )

    for (const absPath of files) {
      const relPath = await this.runOnFile(absPath)
      if (relPath) processedFiles.push(relPath)
    }

    logInfo(
      `[Indexer] Indexed ${processedFiles.length} files. Total found: ${files.length}`,
    )

    logInfo(`[Indexer] Step 1 complete.`)

    return processedFiles
  }

  /** Load an enhancer for files of a given type. This method retrieves or creates an enhancer instance based on the provided file extension, initializes it if necessary, and returns the enhancer if successful. If no enhancer is found or initialization fails, it returns null. */
  private async loadEnhancerForFileType(ext: string): Promise<Enhancer | null> {
    if (this.enhancers[ext]) {
      return this.enhancers[ext]
    }

    const EnhancerClass = fileTypeToEnhancerMap[ext]
    if (!EnhancerClass) {
      return null
    }

    const enhancer = new EnhancerClass(this.options.cwd)
    const initialized = await enhancer.init()
    if (initialized) {
      this.enhancers[ext] = enhancer
      logInfo(`[Indexer] Loaded enhancer for .${ext} files.`)
      return enhancer
    } else {
      logError(
        `[Indexer] Failed to initialize enhancer for .${ext} files. It will be skipped.`,
      )
      return null
    }
  }

  /** Runs an enhancement step to improve symbol information in processed files by leveraging type-specific enhancers for better indexing and analysis. */
  async runEnhancementStep(processedFiles: string[]): Promise<void> {
    logInfo(
      `[Indexer] Running Step 2: Symbol Enhancement on ${processedFiles.length} files...`,
    )

    const processedFilesByExt: Record<string, string[]> = {}
    for (const file of processedFiles) {
      const ext = file.split('.').pop() || ''
      if (!processedFilesByExt[ext]) {
        processedFilesByExt[ext] = []
      }
      processedFilesByExt[ext].push(file)
    }

    for (const ext in processedFilesByExt) {
      const enhancer = await this.loadEnhancerForFileType(ext)
      if (enhancer) {
        await enhancer.enhanceSymbolTypes(
          this.options.store,
          processedFilesByExt[ext]!,
        )
        await enhancer.resolveAllPendingCalls(this.options.store)
      }
    }

    logInfo(`[Indexer] Step 2 complete.`)
  }

  /** Runs the step responsible for generating docstrings as part of the documentation process. */
  async runDocstringStep(relativePath?: string): Promise<void> {
    const step = new DocstringGenerationStep(this.options.cwd)
    if (relativePath) {
      await step.runOnOneFile(relativePath, this.options.store)
    } else {
      await step.run(this.options.store)
    }
  }
}
