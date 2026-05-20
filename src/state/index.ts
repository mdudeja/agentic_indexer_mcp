import type { AppState, IStateManager } from './types'

type ObjectStateKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends object ? K : never
}[keyof T]

/** Singleton class for managing the application state with methods for item manipulation and retrieval. */
export class AppStateManager implements IStateManager {
  private state: AppState = {}
  private static instance: AppStateManager

  /** Prevents external instantiation of the AppStateManager class. */
  private constructor() {}

  /** Returns the singleton instance of the AppStateManager. */
  public static getInstance(): AppStateManager {
    if (!AppStateManager.instance) {
      AppStateManager.instance = new AppStateManager()
    }
    return AppStateManager.instance
  }

  /** Sets the value for the specified key in the application state. */
  setItem<K extends keyof AppState>(key: K, value: AppState[K]): void {
    this.state[key] = value
  }

  /** Updates an existing state item by merging a partial value into it, throwing an error if the key is not found. */
  updateItem<K extends ObjectStateKeys<AppState>>(
    key: K,
    value: Partial<NonNullable<AppState[K]>>,
  ): void {
    const current = this.state[key]
    if (current == null) {
      throw new Error(`Cannot update non-existent key: ${key}`)
    }
    this.state[key] = {
      ...(current as NonNullable<AppState[K]>),
      ...value,
    } as AppState[K]
  }

  /** Removes the item associated with the specified key from the application state. */
  deleteItem<K extends keyof AppState>(key: K): void {
    delete this.state[key]
  }

  /** Retrieves the value associated with the specified key from the application state. */
  getItem<K extends keyof AppState>(key: K): AppState[K] | undefined {
    return this.state[key]
  }

  /** Returns the current application state. */
  getState(): AppState {
    return this.state
  }

  /** Resets the internal state to an empty object. */
  dispose() {
    this.state = {}
  }
}
