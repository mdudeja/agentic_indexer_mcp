export const PY_GLOBAL_CALLS = new Set([
  // I/O / debugging
  'print',
  'input',
  'open',
  'breakpoint',

  // Introspection
  'type',
  'isinstance',
  'issubclass',
  'callable',
  'hasattr',
  'getattr',
  'setattr',
  'delattr',
  'id',
  'hash',
  'dir',
  'vars',
  'globals',
  'locals',

  // Type constructors
  'str',
  'int',
  'float',
  'bool',
  'bytes',
  'bytearray',
  'memoryview',
  'complex',
  'object',

  // Collections / iterables
  'list',
  'dict',
  'set',
  'frozenset',
  'tuple',
  'range',
  'slice',
  'iter',
  'next',
  'enumerate',
  'zip',
  'map',
  'filter',
  'reversed',
  'sorted',

  // Numeric / aggregation
  'len',
  'sum',
  'min',
  'max',
  'abs',
  'round',
  'pow',
  'divmod',
  'all',
  'any',

  // Representation / formatting
  'repr',
  'ascii',
  'format',
  'chr',
  'ord',
  'bin',
  'hex',
  'oct',

  // Code/runtime
  'eval',
  'exec',
  'compile',
  '__import__',

  // Descriptors / class helpers
  'property',
  'staticmethod',
  'classmethod',
  'super',

  // Exceptions/classes commonly constructed
  'Exception',
  'BaseException',
  'ValueError',
  'TypeError',
  'RuntimeError',
  'KeyError',
  'IndexError',
  'AttributeError',
  'ImportError',
  'ModuleNotFoundError',
  'NotImplementedError',
  'StopIteration',
])
