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

  constructor(protected cwd: string) {
    this.config = AppStateManager.getInstance().getItem('config') ?? {
      enabled: false,
      languages: {},
      ignore_patterns: [],
      extnToLangMap: {},
    }
  }

  async init(): Promise<boolean> {
    throw new Error('init() not implemented')
  }

  async enhanceSymbolTypes(
    _store: IndexerDB,
    _relPaths: string[],
  ): Promise<void> {
    throw new Error('enhanceSymbolTypes() not implemented')
  }

  async resolveAllPendingCalls(_store: IndexerDB): Promise<void> {
    throw new Error('resolveAllPendingCalls() not implemented')
  }

  refreshFile(_absPath: string): void {
    // Optional method to refresh cached data for a file when it changes
  }
}
