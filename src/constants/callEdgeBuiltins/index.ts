import { CallKind } from 'src/database/schemas'
import type { SupportedLanguage } from 'tree-sitter-wasm'
import { TS_JS_GLOBAL_OBJECTS } from './tsJsObjs'
import { TS_JS_GLOBAL_CALLS } from './tsJsCalls'
import { PY_GLOBAL_CALLS } from './pyCalls'

const builtins: {
  [language in SupportedLanguage]?: { [callKind in CallKind]?: Set<string> }
} = {
  typescript: {
    [CallKind.FunctionCall]: TS_JS_GLOBAL_CALLS,
    [CallKind.MethodCall]: TS_JS_GLOBAL_OBJECTS,
    [CallKind.ConstructorCall]: TS_JS_GLOBAL_OBJECTS,
  },
  python: {
    [CallKind.FunctionCall]: PY_GLOBAL_CALLS,
  },
}

/** Returns a set of built-in function or method names for the specified programming language and call type. */
export function getBuiltins(
  language: SupportedLanguage,
  callKind: CallKind,
): Set<string> | undefined {
  return builtins[language]?.[callKind]
}
