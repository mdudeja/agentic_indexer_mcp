; Symbols
(internal_module name: (_) @symbol.namespace)
(ambient_declaration) @symbol.module
(class_declaration name: (type_identifier) @symbol.class)

(function_declaration name: (identifier) @symbol.function)
(generator_function_declaration name: (identifier) @symbol.function)
(method_definition name: (property_identifier) @symbol.method)

(interface_declaration name: (type_identifier) @symbol.interface)
(type_alias_declaration name: (type_identifier) @symbol.typeAlias)
(enum_declaration name: (identifier) @symbol.enum)

(public_field_definition name: (property_identifier) @symbol.field)

(lexical_declaration 
  (variable_declarator 
    name: (identifier) @symbol.var.name) @symbol.var.decl)
(variable_declaration 
  (variable_declarator 
    name: (identifier) @symbol.var.name) @symbol.var.decl)

; Calls
(call_expression
  function: (identifier) @call.identifier)
(call_expression
  function: (member_expression property: (property_identifier) @call.member))
(call_expression
  function: (subscript_expression index: (string) @call.subscript))
(new_expression
  constructor: (identifier) @call.identifier)

; Imports
(import_statement) @import.statement

; Exports
(export_specifier (identifier) @export.identifier)

; Exceptions
(throw_statement) @exception.throw

; Decorators
; Target association is done in the adapter: walk nextNamedSibling past
; other decorators for siblings, or use parent for field children.
(decorator) @symbol.decorator

; EnvVars
; process.env.KEY
(member_expression
  object: (member_expression
    object: (identifier) @_obj
    property: (property_identifier) @_prop)
  property: (property_identifier) @env.key
  (#eq? @_obj "process")
  (#eq? @_prop "env"))

; process.env["KEY"]
(subscript_expression
  object: (member_expression
    object: (identifier) @_obj
    property: (property_identifier) @_prop)
  index: (string) @env.key
  (#eq? @_obj "process")
  (#eq? @_prop "env"))

; Preceding Docstrings
(
  (comment)+ @symbol.docstring
  .
  [
    (class_declaration)
    (interface_declaration)
    (type_alias_declaration)
    (function_declaration)
    (generator_function_declaration)
    (method_definition)
    (public_field_definition)
    (enum_declaration)
    (internal_module)
    (ambient_declaration)
  ] @symbol.docstring.target
)

(
  (comment)+ @symbol.docstring
  .
  [
    (lexical_declaration) @symbol.docstring.target
    (variable_declaration) @symbol.docstring.target
  ]
)

; Preceding Docstrings for Exported Declarations
; (export ...) wraps the declaration, so the comment is a sibling of
; export_statement rather than of the declaration itself.
(
  (comment)+ @symbol.docstring
  .
  (export_statement
    declaration: [
      (class_declaration)
      (interface_declaration)
      (type_alias_declaration)
      (function_declaration)
      (generator_function_declaration)
      (enum_declaration)
      (internal_module)
      (ambient_declaration)
    ] @symbol.docstring.target
  )
)

(
  (comment)+ @symbol.docstring
  .
  (export_statement
    declaration: [
      (lexical_declaration) @symbol.docstring.target
      (variable_declaration) @symbol.docstring.target
    ]
  )
)

; Trailing Inline Docstrings for Variables
(
  [
    (lexical_declaration) @symbol.docstring.target
    (variable_declaration) @symbol.docstring.target
  ]
  .
  (comment)+ @symbol.docstring.trailing
)
