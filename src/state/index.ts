import type { AppState, IStateManager } from './types'

type ObjectStateKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends object ? K : never
}[keyof T]

/** Manages the application's global state, providing methods to set, update, delete, and retrieve state data consistently across the application. */
export class AppStateManager implements IStateManager {
  private state: AppState = {}
  private static instance: AppStateManager

  /** Initializes an instance of the application state manager. */
  private constructor() {}

  /** Returns the singleton instance of AppStateManager to manage application state consistently across the application. */
  public static getInstance(): AppStateManager {
    if (!AppStateManager.instance) {
      AppStateManager.instance = new AppStateManager()
    }
    return AppStateManager.instance
  }

  /** Updates the application state by assigning the given value to the specified key. */
  setItem<K extends keyof AppState>(key: K, value: AppState[K]): void {
    this.state[key] = value
  }

  /** Updates an item in the application state by merging new values with the existing ones. Throws an error if the specified key does not exist in the current state. */
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

  /** Deletes an item from the application state using the provided key. */
  deleteItem<K extends keyof AppState>(key: K): void {
    delete this.state[key]
  }

  /** Retrieves an item from the component's state based on the provided key. Returns the corresponding value stored in the component's state or undefined if not found. */
  getItem<K extends keyof AppState>(key: K): AppState[K] | undefined {
    return this.state[key]
  }

  /** Retrieves the current application state. */
  getState(): AppState {
    return this.state
  }

  /** "Reset internal state for cleanup." */
  dispose() {
    this.state = {}
  }
}
