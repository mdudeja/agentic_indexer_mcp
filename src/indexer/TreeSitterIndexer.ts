import { Parser, Language } from 'web-tree-sitter'

import type {
  IndexedSymbol,
  IndexedImport,
  IndexedSymbolCall,
  IndexerConfig,
  IndexedException,
  IndexedEnvVar,
} from '../config/types'
import { logError } from 'src/utils/logger'
import { AppStateManager } from 'src/state'
import { extractSymbols } from './steps/s1_symbol_extractor'

/** A utility class for managing code parsing and indexing using TreeSitter. It handles initialization of parsers, loading language grammars from WebAssembly modules, and extracting code elements like symbols and imports from source files based on file extensions and configured language settings. */
export class TreeSitterIndexer {
  private parser: Parser | null = null
  private languages: Map<string, any> = new Map()
  private config: IndexerConfig

  /** Initializes the configuration using values from AppStateManager or default settings. */
  constructor() {
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

  /** Initializes the parser and prepares it for parsing operations. */
  async init() {
    await Parser.init()
    this.parser = new Parser()
  }

  /** Load and return the language grammar for the specified language name. If the language is not already loaded, it will fetch and initialize it from a .wasm file. */
  async loadLanguage(langName: string): Promise<any> {
    if (this.languages.has(langName)) {
      return this.languages.get(langName)!
    }

    try {
      // Find the .wasm file mapped by tree-sitter-wasms
      // Needs dynamic resolution because package paths might differ
      const wasmPath = require.resolve(
        `tree-sitter-wasms/out/tree-sitter-${langName}.wasm`,
      )
      const lang = await Language.load(wasmPath)
      this.languages.set(langName, lang)
      return lang
    } catch (err) {
      logError(`Failed to load WASM grammar for ${langName}`)
      logError('', err)
      throw new Error(`Failed to load WASM grammar for ${langName}`)
    }
  }

  /** Parses source code to extract symbols, imports, calls, exceptions, and env variables. */
  async parse(
    sourceCode: string,
    ext: string,
    filePath: string,
  ): Promise<{
    symbols: IndexedSymbol['Select'][]
    imports: IndexedImport['Select'][]
    calls: IndexedSymbolCall['Insert'][]
    exceptions: IndexedException['Select'][]
    envVars: IndexedEnvVar['Select'][]
  }> {
    if (!this.parser) {
      await this.init()
    }

    try {
      const langName = this.config.extnToLangMap[ext]

      if (!langName) {
        logError(`No language mapping found for extension: ${ext}`)
        return { symbols: [], imports: [], calls: [], exceptions: [], envVars: [] }
      }

      const tree = await this.parseFile(sourceCode, langName)

      if (!tree) {
        return { symbols: [], imports: [], calls: [], exceptions: [], envVars: [] }
      }

      const treesitterConfig = this.config.languages?.[langName]?.treesitter

      if (!treesitterConfig) {
        logError(`No Tree-sitter config found for language: ${langName}`)
        return { symbols: [], imports: [], calls: [], exceptions: [], envVars: [] }
      }

      return extractSymbols(tree.rootNode, filePath, treesitterConfig)
    } catch (err) {
      logError(`Error parsing file ${filePath}`)
      logError('', err)
      return { symbols: [], imports: [], calls: [], exceptions: [], envVars: [] }
    }
  }

  /** Parse the given source code using the specified programming language, returning the parsed result. */
  async parseFile(sourceCode: string, langName: string): Promise<any> {
    const lang = await this.loadLanguage(langName)

    if (!this.parser) {
      throw new Error('TreeSitterIndexer not initialized')
    }

    this.parser.setLanguage(lang)
    return this.parser.parse(sourceCode)
  }
}
