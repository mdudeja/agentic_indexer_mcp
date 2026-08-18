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

/** An outbound call edge joined with its call site's textual details. */
export type OutboundCallEdge = {
  caller_id: string
  callee_id: string | null
  imports_id: string | null
  callee_name: string
  call_line: number | null
  call_column: number | null
  call_text: string
  docstring: string | null
  target_kind: string
  resolution_source: string
  /** True when the edge resolved to a builtin/lang feature (equivalent to legacy is_lang_feature). */
  is_lang_feature: boolean
}
