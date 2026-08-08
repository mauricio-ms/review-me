//! Tree-sitter queries per language. Adding a grammar = add a `queries::<lang>`
//! module here plus a parser registration in `xref.rs`.

pub mod java {
    /// Declaration sites, captured by kind. Capture names map to `SymbolKind` in
    /// `xref.rs`.
    pub const DEFINITIONS: &str = r#"
        (class_declaration name: (identifier) @def.class)
        (interface_declaration name: (identifier) @def.interface)
        (enum_declaration name: (identifier) @def.enum)
        (record_declaration name: (identifier) @def.class)
        (annotation_type_declaration name: (identifier) @def.interface)
        (constructor_declaration name: (identifier) @def.method)
        (method_declaration name: (identifier) @def.method)
        (field_declaration
            declarator: (variable_declarator name: (identifier) @def.field))
        (enum_constant name: (identifier) @def.field)
    "#;

    /// Every identifier/type-name occurrence — usages are resolved by name match.
    pub const REFERENCES: &str = r#"
        (identifier) @ref
        (type_identifier) @ref
    "#;
}
