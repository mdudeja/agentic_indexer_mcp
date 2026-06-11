import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { IndexerConfig, LanguageConfig } from 'src/config/types'
import type { Watcher } from 'src/watcher/Watcher'

export type TreesitterConfig = LanguageConfig['treesitter']
export type ListName = keyof TreesitterConfig['lists']

export type AppState = {
  root?: string
  config?: IndexerConfig
  kindToListMap?: Map<string, Map<string, ListName>> // language → (kind → list)
  server?: McpServer
  watcher?: Watcher
  tsMorphEnhancer?: any
  pyLspEnhancer?: any
  luaLspEnhancer?: any
  goLspEnhancer?: any
}

export interface IStateManager {
  setItem(key: keyof AppState, value: any): void
  updateItem(key: keyof AppState, value: any): void
  deleteItem(key: keyof AppState): void
  getItem(key: keyof AppState): any
  getState(): AppState
}
