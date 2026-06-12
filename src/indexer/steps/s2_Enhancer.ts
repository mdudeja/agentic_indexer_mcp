export interface ParamInfo {
  name: string
  type: string
  optional: boolean
}

export interface ResolvedCallableTypeInfo {
  params: ParamInfo[]
  returnType: string
}

export interface Enhancer {
  init(): Promise<boolean>
  enhanceSymbolTypesForCallables(relPaths: string[]): Promise<void>
  enhanceInterfaceInheritence(relPaths: string[]): Promise<void>
  enhanceTypeInheritence(relPaths: string[]): Promise<void>
  resolveAllPendingCalls(relPaths: string[]): Promise<void>
  refreshFile(absPath: string): void
  getTypeAtLocation(
    absPath: string,
    line: number,
    column: number,
  ): Promise<string | null>
  dispose(): Promise<void>
}
