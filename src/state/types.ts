import type { IndexerConfig } from 'src/config/types'

export type AppState = {
  root?: string
  config?: IndexerConfig
}

export interface IStateManager {
  setItem(key: keyof AppState, value: any): void
  updateItem(key: keyof AppState, value: any): void
  deleteItem(key: keyof AppState): void
  getItem(key: keyof AppState): any
  getState(): AppState
}
