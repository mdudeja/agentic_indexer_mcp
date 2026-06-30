export interface Enhancer {
  init(): Promise<boolean>
  enhanceSymbolTypesForCallables(relPaths: string[]): Promise<void>
  enhanceInterfaceInheritence(relPaths: string[]): Promise<void>
  enhanceTypeInheritence(relPaths: string[]): Promise<void>
  resolveAllPendingCalls(relPaths: string[]): Promise<void>
  prepareFiles(relPaths: string[]): Promise<void>
  closeFiles(relPaths: string[]): Promise<void>
  refreshFile(absPath: string): void
  getTypeAtLocation(
    absPath: string,
    line: number,
    column: number,
  ): Promise<string | null>
  dispose(): Promise<void>
}
