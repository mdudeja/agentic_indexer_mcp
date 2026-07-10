import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { IndexerConfig } from 'src/config/types'
import type { FileManager } from 'src/indexer/FileManager'
import type { Enhancer } from 'src/indexer/steps/s2_Enhancer'
import type { Watcher } from 'src/watcher/Watcher'

export type AppState = {
  root?: string
  config?: IndexerConfig
  includeGitIgnored?: boolean
  server?: McpServer
  watcher?: Watcher
  lspEnhancers?: Map<string, Enhancer>
  fileManager?: FileManager
}

export interface IStateManager {
  setItem(key: keyof AppState, value: any): void
  updateItem(key: keyof AppState, value: any): void
  deleteItem(key: keyof AppState): void
  getItem(key: keyof AppState): any
  getState(): AppState
}
