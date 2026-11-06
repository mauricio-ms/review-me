import type { ProjectSource } from "./repo";

export type GrepScope = "repository" | "changed";
export type SearchRequest = {
  repo: string;
  source: ProjectSource;
  query: string;
  only: string[] | null;
};
export type SearchHit = {
  path: string;
  line: number;
  /** Zero-based UTF-16 column. */
  col: number;
  snippet: string;
  ranges: { from: number; to: number }[];
};
export type SearchResults = {
  hits: SearchHit[];
  truncated: boolean;
  skippedFiles: number;
  skippedLines: number;
  cancelled: boolean;
};
