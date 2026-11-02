export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "method"
  | "function"
  | "field"
  | "type"
  | "module"
  | "identifier";

export interface SymbolRef {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  col: number;
}

export type XrefKind = "definition" | "reference";

export interface XrefResult {
  file: string;
  line: number;
  col: number;
  snippet: string;
  kind: XrefKind;
  symbolKind: SymbolKind;
  /**
   * True when the backend *proved* this occurrence refers to the symbol under the
   * cursor. False means "matches by name, couldn't be decided" — never "wrong":
   * occurrences proven to mean something else are dropped rather than flagged, so an
   * unconfirmed result is still worth looking at.
   */
  confirmed: boolean;
}

export interface IndexStats {
  files: number;
  symbols: number;
}

/** A symbol's occurrences in one file, as `symbol_occurrences` returns them. */
export interface Occurrences {
  name: string;
  /** 1-based line, 0-based UTF-16 column; the cursor's own one included. */
  spans: { line: number; col: number }[];
}

/** `xref_audit`: where a revision's JavaScript and TypeScript imports lead. */
export interface ImportAudit {
  files: number;
  imports: number;
  /** Into the project's own files. */
  resolved: number;
  /** Packages, the runtime, a framework's virtual modules. */
  external: number;
  /** Every import nothing accounts for, where it's written. */
  unresolved: XrefResult[];
  /** The unresolved ones by how they start (`@/…`, `./…`, a package), most first. */
  patterns: [string, number][];
}
