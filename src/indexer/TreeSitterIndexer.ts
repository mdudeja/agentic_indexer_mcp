import { Parser, Language, Tree } from 'web-tree-sitter'
import { existsSync } from 'fs'
import type { IndexerConfig, IndexedSymbol } from './types'
import { logWarning } from 'src/utils/logger.js'

export class TreeSitterIndexer {
  private parser: Parser | null = null
  private languages: Map<string, Language> = new Map()
  private config: IndexerConfig | null = null

  private extnToLangMap = {}

  async init(config: IndexerConfig) {
    this.config = config

    this.extnToLangMap = {
      tsx: 'tsx',
      ts: 'typescript',
      js: 'javascript',
    }

    await Parser.init()
    this.parser = new Parser()
  }

  getStrategy(langName: string): 'native' | 'wasm' {
    const langConfig = this.config?.languages[langName]
    if (
      langConfig?.treesitter?.parser &&
      existsSync(langConfig.treesitter.parser)
    ) {
      // NOTE: native .so loading via tree-sitter node bindings
      // would happen here. For now, since web-tree-sitter doesn't
      // support .so files, we'll try to use a CLI approach later
      // or standard tree-sitter if installed.
      // We will fallback to WASM if native is not strictly requested yet.
      return 'native'
    }
    return 'wasm'
  }

  async loadLanguage(langName: string): Promise<Language> {
    if (this.languages.has(langName)) {
      return this.languages.get(langName)!
    }

    const strategy = this.getStrategy(langName)

    if (strategy === 'wasm') {
      // Forcing WASM for the initial spike
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
        throw new Error(`Failed to load WASM grammar for ${langName}: ${err}`)
      }
    }

    throw new Error(
      `Strategy ${strategy} not fully implemented for language loading yet`,
    )
  }

  async parse(
    sourceCode: string,
    ext: string,
    filePath: string,
  ): Promise<IndexedSymbol['Select'][]> {
    if (!this.parser) {
      await this.init({ enabled: true, languages: {} } as IndexerConfig)
    }

    try {
      const langName = this.extnToLangMap[ext]
      const tree = await this.parseFile(sourceCode, langName)

      if (!tree) {
        return []
      }

      // only typescript available for now
      const { extractTypeScriptSymbols } =
        await import('./languages/typescript.js')
      return extractTypeScriptSymbols(tree.rootNode, filePath)
    } catch {
      logWarning('Language not found')
      return []
    }
  }

  async parseFile(sourceCode: string, langName: string): Promise<Tree | null> {
    if (!this.parser) {
      throw new Error('TreeSitterIndexer not initialized')
    }

    const lang = await this.loadLanguage(langName)
    this.parser.setLanguage(lang)
    return this.parser.parse(sourceCode)
  }
}
