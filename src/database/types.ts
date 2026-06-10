export type NestedCaller = {
  callerFile: string
  callerName: string
  line: number
  childName: string | null
  childFilePath: string | null
  childLine: number | null
}

export type DirectCaller = {
  callerFile: string
  callerName: string
  line: number
}
