export const TS_JS_GLOBAL_OBJECTS = new Set([
  // Core JS
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Symbol',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Promise',
  'Reflect',
  'Proxy',
  'Intl',

  // Collections
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',

  // Errors
  'Error',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'RangeError',
  'URIError',
  'AggregateError',

  // Platform globals
  'console',
  'process',
  'Buffer',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'Blob',
  'File',
  'FormData',
  'Headers',
  'Request',
  'Response',

  // Bun-specific
  'Bun',
])
