export type NestedCaller = {
  callerId: string
  callerFile: string
  callerName: string
  line: number
  childName: string | null
  childFilePath: string | null
  childLine: number | null
}

export type DirectCaller = {
  callerId: string
  callerFile: string
  callerName: string
  line: number
}
