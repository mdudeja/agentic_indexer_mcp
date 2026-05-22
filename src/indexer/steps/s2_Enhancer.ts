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

  /** Initializes the Enhancer with configuration data from storage or default values. */
  constructor(protected cwd: string) {
    this.config = AppStateManager.getInstance().getItem('config') ?? {
      enabled: false,
      languages: {},
      ignore_patterns: [],
      extnToLangMap: {},
    }
  }

  /** Initialize resources required for the application to function properly. Returns a boolean indicating whether the initialization succeeded. */
  async init(): Promise<boolean> {
    throw new Error('init() not implemented')
  }

  /** Enhances symbol types for files at specified relative paths in the indexer database. This method processes each file location to improve or refine symbol type information within the system. */
  async enhanceSymbolTypes(
    _store: IndexerDB,
    _relPaths: string[],
  ): Promise<void> {
    throw new Error('enhanceSymbolTypes() not implemented')
  }

  /** Resolve all pending calls that have not yet been processed. This method ensures that any outstanding operations are addressed and cleared from the system. */
  async resolveAllPendingCalls(_store: IndexerDB): Promise<void> {
    throw new Error('resolveAllPendingCalls() not implemented')
  }

  /** Refreshes cached data for a file at the specified absolute path when it has been modified. */
  refreshFile(_absPath: string): void {
    // Optional method to refresh cached data for a file when it changes
  }
}
