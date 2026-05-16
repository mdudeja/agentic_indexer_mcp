import { Parser, Language } from 'web-tree-sitter'

import type {
  IndexedSymbol,
  IndexedImport,
  IndexedSymbolCall,
  IndexerConfig,
} from '../config/types.js'
import { logError } from 'src/utils/logger.js'
import { AppStateManager } from 'src/state'
import { extractSymbols } from './steps/s1_symbol_extractor.js'

export class TreeSitterIndexer {
  private parser: Parser | null = null
  private languages: Map<string, any> = new Map()
  private config: IndexerConfig

  constructor() {
    this.config = AppStateManager.getInstance().getItem('config') ?? {
      enabled: false,
      languages: {},
      ignore_patterns: [],
      extnToLangMap: {},
    }
  }

  async init() {
    await Parser.init()
    this.parser = new Parser()
  }

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

  async parse(
    sourceCode: string,
    ext: string,
    filePath: string,
  ): Promise<{
    symbols: IndexedSymbol['Select'][]
    imports: IndexedImport['Select'][]
    calls: IndexedSymbolCall['Insert'][]
  }> {
    if (!this.parser) {
      await this.init()
    }

    try {
      const langName = this.config.extnToLangMap[ext]

      if (!langName) {
        logError(`No language mapping found for extension: ${ext}`)
        return { symbols: [], imports: [], calls: [] }
      }

      const tree = await this.parseFile(sourceCode, langName)

      if (!tree) {
        return { symbols: [], imports: [], calls: [] }
      }

      const treesitterConfig = this.config.languages?.[langName]?.treesitter

      if (!treesitterConfig) {
        logError(`No Tree-sitter config found for language: ${langName}`)
        return { symbols: [], imports: [], calls: [] }
      }

      return extractSymbols(tree.rootNode, filePath, treesitterConfig)
    } catch (err) {
      logError(`Error parsing file ${filePath}`)
      logError('', err)
      return { symbols: [], imports: [], calls: [] }
    }
  }

  async parseFile(sourceCode: string, langName: string): Promise<any> {
    const lang = await this.loadLanguage(langName)

    if (!this.parser) {
      throw new Error('TreeSitterIndexer not initialized')
    }

    this.parser.setLanguage(lang)
    return this.parser.parse(sourceCode)
  }
}
