; Symbols
(class_declaration name: (type_identifier) @symbol.class)
(interface_declaration name: (type_identifier) @symbol.interface)
(type_alias_declaration name: (type_identifier) @symbol.typeAlias)
(enum_declaration name: (identifier) @symbol.enum)
(internal_module name: (_) @symbol.namespace)
(ambient_declaration) @symbol.module

(function_declaration name: (identifier) @symbol.function)
(generator_function_declaration name: (identifier) @symbol.function)
(arrow_function) @symbol.arrow_function ; requires parent var matching

(method_definition name: (property_identifier) @symbol.method)
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

; Imports
(import_statement) @import.statement

; Exceptions
(throw_statement) @exception.throw

; EnvVars
(member_expression
  object: (identifier) @env.obj
  property: (property_identifier) @env.prop)
(subscript_expression
  object: (identifier) @env.obj
  index: (string) @env.index)

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
    (lexical_declaration (variable_declarator) @symbol.docstring.target)
    (variable_declaration (variable_declarator) @symbol.docstring.target)
  ]
)

; Trailing Inline Docstrings for Variables
(
  [
    (lexical_declaration (variable_declarator) @symbol.docstring.target)
    (variable_declaration (variable_declarator) @symbol.docstring.target)
  ]
  .
  (comment)+ @symbol.docstring.trailing
)
