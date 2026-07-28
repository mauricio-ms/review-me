export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "method"
  | "field"
  | "type"
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
