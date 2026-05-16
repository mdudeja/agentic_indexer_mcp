import type { IndexerConfig, LanguageConfig } from 'src/config/types'

export type TreesitterConfig = LanguageConfig['treesitter']
export type ListName = keyof TreesitterConfig['lists']

export type AppState = {
  root?: string
  config?: IndexerConfig
  kindToListMap?: Map<string, Map<string, ListName>> // language → (kind → list)
}

export interface IStateManager {
  setItem(key: keyof AppState, value: any): void
  updateItem(key: keyof AppState, value: any): void
  deleteItem(key: keyof AppState): void
  getItem(key: keyof AppState): any
  getState(): AppState
}
