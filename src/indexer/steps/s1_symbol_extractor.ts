import type { Node, Query } from 'web-tree-sitter'
import {
  type IndexedSymbol,
  type IndexedImport,
  type IndexedSymbolCall,
  type IndexedException,
  type IndexedEnvVar,
} from '../../config/types'
import { TypescriptAdapter } from '../adapters/TypescriptAdapter'
import { PythonAdapter } from '../adapters/PythonAdapter'
import { LuaAdapter } from '../adapters/LuaAdapter'
import { type LanguageAdapter } from '../adapters/LanguageAdapter'
import { logError } from '../../utils/logger'

const adapters: Record<string, LanguageAdapter> = {
  typescript: new TypescriptAdapter(),
  tsx: new TypescriptAdapter(),
  python: new PythonAdapter(),
  lua: new LuaAdapter(),
}

/** Extracts and collects symbols, imports, and calls from the provided AST (root node) based on the given configuration, using language-specific adapters and tree-sitter queries. */
export function extractSymbols(
  rootNode: Node,
  file_path: string,
  langName: string,
  query?: Query
): {
  symbols: IndexedSymbol['Select'][]
  imports: IndexedImport['Select'][]
  calls: IndexedSymbolCall['Insert'][]
  exceptions: IndexedException['Select'][]
  envVars: IndexedEnvVar['Select'][]
} {
  const defaultResult = {
    symbols: [],
    imports: [],
    calls: [],
    exceptions: [],
    envVars: [],
  }

  if (!rootNode || !query) {
    return defaultResult
  }

  const adapter = adapters[langName]
  if (!adapter) {
    logError(`No language adapter found for language: ${langName}`)
    return defaultResult
  }

  try {
    const matches = query.matches(rootNode)
    return adapter.extract(matches, file_path)
  } catch (err) {
    logError(`Extraction failed for file ${file_path}`, err)
    return defaultResult
  }
}
