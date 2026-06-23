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

; Exports
(assignment
  left: (identifier) @_name
  right: (list (string) @export.identifier)
  (#eq? @_name "__all__"))

; Exceptions
(raise_statement) @exception.raise

; EnvVars
; environ["KEY"]
(subscript
  value: (identifier) @_obj
  subscript: (string) @env.key
  (#eq? @_obj "environ"))

; os.environ["KEY"]
(subscript
  value: (attribute
    object: (identifier) @_module
    attribute: (identifier) @_attr)
  subscript: (string) @env.key
  (#eq? @_module "os")
  (#eq? @_attr "environ"))

; os.getenv("KEY")
(call
  function: (attribute
    object: (identifier) @_module
    attribute: (identifier) @_func)
  arguments: (argument_list (string) @env.key)
  (#eq? @_module "os")
  (#eq? @_func "getenv"))

; environ.get("KEY")
(call
  function: (attribute
    object: (identifier) @_module
    attribute: (identifier) @_func)
  arguments: (argument_list (string) @env.key)
  (#eq? @_module "environ")
  (#eq? @_func "get"))

; os.environ.get("KEY")
(call
  function: (attribute
    object: (attribute
      object: (identifier) @_module
      attribute: (identifier) @_attr)
    attribute: (identifier) @_func)
  arguments: (argument_list (string) @env.key)
  (#eq? @_module "os")
  (#eq? @_attr "environ")
  (#eq? @_func "get"))

; Decorators
(decorated_definition
  (decorator) @symbol.decorator
  definition: [
    (function_definition)
    (class_definition)
  ] @symbol.decorator.target
)

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
