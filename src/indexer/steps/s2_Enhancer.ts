import type { IndexerConfig } from 'src/config/types'
import type { IndexerDB } from 'src/database/IndexerDB'
import { AppStateManager } from 'src/state'

export interface ParamInfo {
  name: string
  type: string
  optional: boolean
}

export interface ResolvedSignature {
  params: ParamInfo[]
  returnType: string
}

export abstract class Enhancer {
  protected config: IndexerConfig
  protected available = false
  protected initialized = false

  /** Initializes a new Enhancer instance with the specified working directory and loads the application configuration. */
  constructor(protected cwd: string) {
    this.config = AppStateManager.getInstance().getItem('config') ?? {
      enabled: false,
      languages: {},
      ignore_patterns: [],
      extnToLangMap: {},
    }
  }

  /** Initializes the instance and returns a boolean indicating success. */
  async init(): Promise<boolean> {
    throw new Error('init() not implemented')
  }

  /** Enriches symbol type metadata for the specified relative paths within the indexer store. */
  async enhanceSymbolTypes(
    _store: IndexerDB,
    _relPaths: string[],
  ): Promise<void> {
    throw new Error('enhanceSymbolTypes() not implemented')
  }

  /** Resolves all pending calls within the specified indexer database store. */
  async resolveAllPendingCalls(_store: IndexerDB): Promise<void> {
    throw new Error('resolveAllPendingCalls() not implemented')
  }

  /** Refreshes cached data for a file at the specified absolute path when it changes. */
  refreshFile(_absPath: string): void {
    // Optional method to refresh cached data for a file when it changes
  }
}
