import { Parser, Language } from 'web-tree-sitter'

import type {
  IndexedSymbol,
  IndexedImport,
  SymbolReference,
  IndexerConfig,
} from '../config/types.js'
import { logError } from 'src/utils/logger.js'
import { AppStateManager } from 'src/state'


export class TreeSitterIndexer {
  private parser: Parser | null = null
  private languages: Map<string, any> = new Map()

  private extnToLangMap = {}

  async init() {
    this.extnToLangMap = {
      tsx: 'tsx',
      ts: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
    }

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
    references: SymbolReference['Select'][]
  }> {
    if (!this.parser) {
      await this.init()
    }

    try {
      const langName = this.extnToLangMap[ext]
      const tree = await this.parseFile(sourceCode, langName)

      if (!tree) {
        return { symbols: [], imports: [], references: [] }
      }

      // only typescript available for now
      const { extractSymbols: extractTypeScriptSymbols } =
        await import('./steps/symbol_extractor.js')
      
      const config = AppStateManager.getInstance().getItem('config') as IndexerConfig | null
      const tsConfig = config?.languages?.typescript?.treesitter

      return extractTypeScriptSymbols(tree.rootNode, filePath, tsConfig)
    } catch (err) {
      logError(`Error parsing file ${filePath}`)
      logError('', err)
      return { symbols: [], imports: [], references: [] }
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
