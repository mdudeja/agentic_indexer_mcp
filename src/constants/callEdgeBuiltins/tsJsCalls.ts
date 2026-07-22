export const TS_JS_GLOBAL_CALLS = new Set([
  // Parsing / numbers
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',

  // Timers / async globals
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',

  // Runtime/browser-ish globals
  'fetch',
  'alert',
  'confirm',
  'prompt',

  // Encoding
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',

  // JS constructors that are often called without `new`
  'Date',
  'Error',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'RangeError',
  'URIError',
  'EvalError',

  // Bun / Node-ish, optional depending on target
  'require',
])
