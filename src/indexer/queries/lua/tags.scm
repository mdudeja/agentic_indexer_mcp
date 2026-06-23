; Symbols
(function_declaration 
  name: (_) @symbol.function.name) @symbol.function.decl
(local_function_declaration 
  name: (identifier) @symbol.function.name) @symbol.function.decl

(variable_declaration
  (identifier) @symbol.var.name) @symbol.var.decl
(assignment_statement
  (variable_list (identifier) @symbol.var.name)) @symbol.var.decl

; Calls
(function_call
  name: (identifier) @call.identifier)
(function_call
  name: (method_index_expression method: (identifier) @call.method))
(function_call
  name: (dot_index_expression field: (identifier) @call.member))

; Imports
(function_call 
  name: (identifier) @_name
  (#eq? @_name "require")) @import.statement

; Exports
(return_statement (expression_list (identifier) @export.identifier))

; Exceptions
(function_call 
  name: (identifier) @_name
  (#eq? @_name "error")) @exception.raise

; EnvVars
; os.getenv("KEY")
(function_call
  name: (dot_index_expression
    table: (identifier) @_tbl
    field: (identifier) @_fld)
  arguments: (arguments (string) @env.key)
  (#eq? @_tbl "os")
  (#eq? @_fld "getenv"))

; Preceding Docstrings
(
  (comment)+ @symbol.docstring
  .
  [
    (function_declaration)
    (local_function_declaration)
    (variable_declaration)
  ] @symbol.docstring.target
)

(
  (comment)+ @symbol.docstring
  .
  (assignment_statement (variable_list) @symbol.docstring.target)
)

; Trailing Inline Docstrings for Variables
(
  [
    (variable_declaration) @symbol.docstring.target
    (assignment_statement (variable_list) @symbol.docstring.target)
  ]
  .
  (comment)+ @symbol.docstring.trailing
)
