; Symbols
(class_definition name: (identifier) @symbol.class)
(function_definition name: (identifier) @symbol.function)

(assignment 
  left: (identifier) @symbol.var.name) @symbol.var.decl

; Calls
(call
  function: (identifier) @call.identifier)
(call
  function: (attribute attribute: (identifier) @call.member))

; Imports
(import_statement) @import.statement
(import_from_statement) @import.statement

; Exceptions
(raise_statement) @exception.raise

; EnvVars
(subscript
  value: (identifier) @env.obj
  subscript: (string) @env.index)
(subscript
  value: (attribute attribute: (identifier) @env.obj)
  subscript: (string) @env.index)
(call
  function: (attribute attribute: (identifier) @env.func))

; Docstrings
(class_definition
  body: (block
    .
    (expression_statement (string) @symbol.docstring)
  )
) @symbol.docstring.target

(function_definition
  body: (block
    .
    (expression_statement (string) @symbol.docstring)
  )
) @symbol.docstring.target
