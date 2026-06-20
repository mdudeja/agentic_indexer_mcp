import type { Node, Query } from 'web-tree-sitter'
import { TypescriptAdapter } from '../adapters/TypescriptAdapter'
import { PythonAdapter } from '../adapters/PythonAdapter'
import { LuaAdapter } from '../adapters/LuaAdapter'
import {
  type ExtractionResult,
  type LanguageAdapter,
} from '../adapters/LanguageAdapter'
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
  query?: Query,
): ExtractionResult {
  const defaultResult: ExtractionResult = {
    symbols: [],
    imports: [],
    calls: [],
    exceptions: [],
    envVars: [],
    explicitExports: [],
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
