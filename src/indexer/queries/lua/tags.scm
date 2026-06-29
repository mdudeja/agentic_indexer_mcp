; Symbols
(function_definition_statement 
  name: (_) @symbol.function.name) @symbol.function.decl
(local_function_definition_statement 
  name: (identifier) @symbol.function.name) @symbol.function.decl

(local_variable_declaration
  (variable_list
    (variable
      (identifier) @symbol.var.name))) @symbol.var.decl
(variable_assignment
  (variable_list
    (variable
      (identifier) @symbol.var.name))) @symbol.var.decl

; Calls
(call
  function: (variable
    name: (identifier) @call.identifier))
(call
  function: (variable
    method: (identifier) @call.method))
(call
  function: (variable
    field: (identifier) @call.member))

; Imports
(call
  function: (variable
    name: (identifier) @_name)
  (#eq? @_name "require")) @import.statement

; Exports
(return_statement (expression_list (variable (identifier) @export.identifier)))

; Exceptions
(call
  function: (variable
    name: (identifier) @_name)
  (#eq? @_name "error")) @exception.raise

; EnvVars
; os.getenv("KEY")
(call
  function: (variable
    table: (identifier) @_tbl
    field: (identifier) @_fld)
  arguments: (argument_list (expression_list (string) @env.key))
  (#eq? @_tbl "os")
  (#eq? @_fld "getenv"))

; Preceding Docstrings
(
  (comment)+ @symbol.docstring
  .
  [
    (function_definition_statement)
    (local_function_definition_statement)
    (local_variable_declaration)
  ] @symbol.docstring.target
)

(
  (comment)+ @symbol.docstring
  .
  (variable_assignment (variable_list) @symbol.docstring.target)
)

; Trailing Inline Docstrings for Variables
(
  [
    (local_variable_declaration) @symbol.docstring.target
    (variable_assignment (variable_list) @symbol.docstring.target)
  ]
  .
  (comment)+ @symbol.docstring.trailing
)
