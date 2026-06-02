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
}

export interface IndexStats {
  files: number;
  symbols: number;
}
