import { join, relative } from 'path'
import { readdir, stat } from 'node:fs/promises'
import { TreeSitterIndexer } from './TreeSitterIndexer.ts'
import { IndexerDB } from '../database/IndexerDB.ts'
import type { IndexerConfig } from 'src/config/types.ts'
import { AppStateManager } from 'src/state/index.ts'
import { logError, logInfo } from 'src/utils/logger.ts'
import type { Enhancer } from './steps/s2_Enhancer.ts'
import { GenericLspEnhancer } from './enhancers/GenericLspEnhancer.ts'
import { DocstringGenerationStep } from './steps/s3_docstring_generator.ts'
import type { EmbeddingGenerator } from './steps/s4_EmbeddingGenerator.ts'
import { OllamaEmbeddingGenerator } from './embedders/OllamaEmbeddingGenerator.ts'
import { hashFileContent } from 'src/utils/hashers.ts'
import { PythonLspEnhancer } from './enhancers/PythonLspEnhancer.ts'
import { TypescriptLspEnhancer } from './enhancers/TypescriptLspEnhancer.ts'

const embedderNameToClass: Record<string, new () => EmbeddingGenerator> = {
  ollama: OllamaEmbeddingGenerator,
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
  private embedders: Record<string, EmbeddingGenerator> = {}

  /** Constructs a new IndexPipeline instance using provided configuration options. Initializes necessary components for indexing operations. */
  constructor(private options: IndexPipelineOptions) {
    this.indexer = new TreeSitterIndexer()
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
      if (
        [...this.ignoreRegexPatterns].some((pattern) =>
          pattern.test(gitignoreFile),
        )
      ) {
        continue
      }
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

  /** Runs the indexing pipeline, orchestrating symbol extraction, enhancement, docstring, and embedding processing for the project. */
  async run() {
    logInfo(`[Indexer] Starting index pipeline in ${this.options.cwd}...`)
    if (
      this.config.ignore_patterns.length > 0 &&
      this.ignoreRegexPatterns.size === 0
    ) {
      await this.populateIgnorePatterns()
    }

    const processedFiles = await this.runSymbolExtractionStep()

    await Bun.sleep(3000) // slight delay to ensure all DB transactions are settled before enhancement

    await this.runEnhancementStep(processedFiles)
    await this.runDocstringStep()
    // await this.runEmbeddingStep(processedFiles)
  }

  /** Processes a file at the specified absolute path, checks for changes, parses content, updates store with new data, and returns the relative path if successful. Returns null if the file is ignored or processing fails. */
  async runOnFile(absPath: string): Promise<string | null> {
    if (
      this.config.ignore_patterns.length > 0 &&
      this.ignoreRegexPatterns.size === 0
    ) {
      await this.populateIgnorePatterns()
    }

    const relPath = relative(this.options.cwd, absPath)
    if ([...this.ignoreRegexPatterns].some((regex) => regex.test(relPath))) {
      return null
    }

    const ext = absPath.split('.').pop() || ''

    try {
      const content = await Bun.file(absPath).text()
      const hash = hashFileContent(content)

      const currentHash = await this.options.store.files.getHash(relPath)
      if (currentHash === hash) return null

      const parsed = await this.indexer.parse(content, ext, relPath)
      if (!parsed) return null

      await this.options.store.files.upsert({
        path: relPath,
        hash,
        language: this.config.extnToLangMap[ext] || 'unknown',
        estimated_tokens: Math.ceil(content.length / 4),
      })
      await this.options.store.symbols.upsert(parsed.symbols)
      await this.options.store.calls.upsert(parsed.calls)
      await this.options.store.imports.upsert(parsed.imports)
      await this.options.store.analysis.upsertExceptions(parsed.exceptions)
      await this.options.store.analysis.upsertEnvVars(parsed.envVars)

      // await this.runEnhancementStep([relPath])
      logInfo(
        `[Indexer] Indexed ${relPath} with ${parsed.symbols.length} symbols, ${parsed.imports.length} imports, ${parsed.calls.length} calls, ${parsed.exceptions.length} exceptions, and ${parsed.envVars.length} env vars.`,
      )
      return relPath
    } catch (e) {
      logError(`[Indexer] Failed to index ${relPath}:`, e)
      return null
    }
  }

  /** Enhances a specific file by processing its content. */
  async enhanceFile(absPath: string): Promise<void> {
    const relPath = relative(this.options.cwd, absPath)
    await this.runEnhancementStep([relPath])
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

    const language = this.config.extnToLangMap[ext]
    if (!language) return null

    const lspCommand = this.config.languages[language]?.lsp_command
    if (!lspCommand || lspCommand.length === 0) {
      return null
    }

    let enhancer: Enhancer

    switch (language) {
      case 'python':
        enhancer = new PythonLspEnhancer(this.options.cwd, lspCommand, language)
        break
      case 'typescript':
      case 'javascript':
        enhancer = new TypescriptLspEnhancer(
          this.options.cwd,
          lspCommand,
          language,
        )
        break
      default:
        enhancer = new GenericLspEnhancer(
          this.options.cwd,
          lspCommand,
          language,
        )
        break
    }
    const initialized = await enhancer.init()
    if (initialized) {
      this.enhancers[ext] = enhancer
      logInfo(`[Indexer] Loaded GenericLspEnhancer for .${ext} files.`)
      return enhancer
    } else {
      logError(
        `[Indexer] Failed to initialize GenericLspEnhancer for .${ext} files. It will be skipped.`,
      )
      return null
    }
  }

  /** Initializes and returns an embedding generator based on configuration settings. */
  private async loadEmbedder(): Promise<EmbeddingGenerator | null> {
    if (!this.config.embedder?.enabled || !this.config.embedder?.provider) {
      logError(
        '[Indexer] Embedder is not enabled or provider is not configured. Skipping embedding generation.',
      )
      return null
    }

    if (this.embedders[this.config.embedder.provider]) {
      return this.embedders[this.config.embedder.provider]!
    }

    const EmbedderClass = embedderNameToClass[this.config.embedder.provider]
    if (!EmbedderClass) {
      logError('[Indexer] Embedder not found. Skipping embedding generation.')
      return null
    }

    const embeddor = new EmbedderClass()
    const initialized = await embeddor.init()
    if (!initialized) {
      logError(
        '[Indexer] Failed to initialize embeddor. Skipping embedding generation.',
      )
      return null
    }

    this.embedders[this.config.embedder.provider] = embeddor
    logInfo('[Indexer] Loaded embeddor.')
    return embeddor
  }

  /** Runs an enhancement step to improve symbol information in processed files by leveraging type-specific enhancers for better indexing and analysis. */
  async runEnhancementStep(processedFiles: string[]): Promise<void> {
    if (!processedFiles || processedFiles.length === 0) {
      await this.populateIgnorePatterns()
      const files = await this.findFiles(this.options.cwd)
      processedFiles = files.map((absPath) =>
        relative(this.options.cwd, absPath),
      )
    }

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
        // Notify LSP of any file content changes before querying it
        for (const relPath of processedFilesByExt[ext]!) {
          enhancer.refreshFile(join(this.options.cwd, relPath))
        }

        await enhancer.prepareFiles(processedFilesByExt[ext]!)
        await enhancer.enhanceSymbolTypesForCallables(processedFilesByExt[ext]!)
        await enhancer.enhanceInterfaceInheritence(processedFilesByExt[ext]!)
        await enhancer.enhanceTypeInheritence(processedFilesByExt[ext]!)
        await enhancer.resolveAllPendingCalls(processedFilesByExt[ext]!)
        await enhancer.closeFiles(processedFilesByExt[ext]!)
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

  /** Runs the embedding generation step, processing all symbols that do not have an embedding. */
  async runEmbeddingStep(processedFiles: string[]): Promise<void> {
    logInfo('[Indexer] Running Step 4: Generating embeddings for symbols...')
    const embedder = await this.loadEmbedder()

    if (!embedder) {
      logError(
        '[Indexer] Embedder is not loaded. Skipping embedding generation.',
      )
      return
    }

    const symbols =
      await this.options.store.embeddings.getSymbolsNeedingEmbeddings(
        processedFiles,
      )
    if (symbols.length === 0) {
      logInfo('[Indexer] No symbols need embeddings. Step 4 complete.')
      return
    }

    logInfo(`[Indexer] Generating embeddings for ${symbols.length} symbols...`)
    let count = 0
    let successCount = 0

    for (const symbol of symbols) {
      count++
      if (count % 50 === 0) {
        logInfo(
          `[Indexer] Processing embeddings: ${count}/${symbols.length}...`,
        )
      }

      // Construct textual context for embedding
      let textToEmbed = `Symbol: ${symbol.name}\nKind: ${symbol.kind}\nFile: ${symbol.file_path}`
      if (symbol.signature) {
        textToEmbed += `\nSignature: ${symbol.signature}`
      }
      if (symbol.docstring) {
        textToEmbed += `\nDocumentation: ${symbol.docstring}`
      }

      const vector = await embedder.getEmbedding(textToEmbed)
      if (vector) {
        await this.options.store.embeddings.upsert(symbol.id, vector)
        successCount++
      }
    }

    logInfo(
      `[Indexer] Step 4 complete. Successfully generated ${successCount}/${symbols.length} embeddings.`,
    )
  }
}
