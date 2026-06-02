// Nerd Font file-type glyphs + colors for the project tree and the fuzzy picker.
//
// The glyphs live in the Nerd Font private-use area, so they only render when a
// Nerd Font is reachable in `--mono` (it is — see styles.css). Plain "JetBrains
// Mono" lacks these codepoints, so the browser does per-glyph fallback to the
// patched font; if no Nerd Font were installed at all the cell just shows the
// fallback box, never broken text. Colors follow the seti-ui / all-the-icons
// palette the user already sees in emacs.

export interface FileIcon {
  glyph: string;
  color: string;
}

const FOLDER_CLOSED: FileIcon = { glyph: "", color: "#5aa9ff" };
const FOLDER_OPEN: FileIcon = { glyph: "", color: "#8cc2ff" };
const GENERIC_FILE: FileIcon = { glyph: "", color: "#8493a3" };

// Keyed by lower-case extension.
const BY_EXT: Record<string, FileIcon> = {
  java: { glyph: "", color: "#e76f00" },
  kt: { glyph: "", color: "#a97bff" },
  kts: { glyph: "", color: "#a97bff" },
  ts: { glyph: "", color: "#3178c6" },
  tsx: { glyph: "", color: "#61dafb" },
  js: { glyph: "", color: "#f1e05a" },
  jsx: { glyph: "", color: "#61dafb" },
  mjs: { glyph: "", color: "#f1e05a" },
  cjs: { glyph: "", color: "#f1e05a" },
  json: { glyph: "", color: "#cbcb41" },
  rs: { glyph: "", color: "#dea584" },
  py: { glyph: "", color: "#3572a5" },
  go: { glyph: "", color: "#00add8" },
  rb: { glyph: "", color: "#cc342d" },
  php: { glyph: "", color: "#8993be" },
  c: { glyph: "", color: "#599eff" },
  h: { glyph: "", color: "#a074c4" },
  cpp: { glyph: "", color: "#f34b7d" },
  cc: { glyph: "", color: "#f34b7d" },
  hpp: { glyph: "", color: "#a074c4" },
  md: { glyph: "", color: "#519aba" },
  markdown: { glyph: "", color: "#519aba" },
  html: { glyph: "", color: "#e44d26" },
  htm: { glyph: "", color: "#e44d26" },
  css: { glyph: "", color: "#563d7c" },
  scss: { glyph: "", color: "#cf649a" },
  sass: { glyph: "", color: "#cf649a" },
  sh: { glyph: "", color: "#89e051" },
  bash: { glyph: "", color: "#89e051" },
  zsh: { glyph: "", color: "#89e051" },
  fish: { glyph: "", color: "#89e051" },
  toml: { glyph: "", color: "#6d8086" },
  yaml: { glyph: "", color: "#6d8086" },
  yml: { glyph: "", color: "#6d8086" },
  ini: { glyph: "", color: "#6d8086" },
  conf: { glyph: "", color: "#6d8086" },
  cfg: { glyph: "", color: "#6d8086" },
  env: { glyph: "", color: "#6d8086" },
  lock: { glyph: "", color: "#8c8c8c" },
  sql: { glyph: "", color: "#dad8d8" },
  xml: { glyph: "", color: "#e37933" },
  svg: { glyph: "", color: "#ffb13b" },
  png: { glyph: "", color: "#a074c4" },
  jpg: { glyph: "", color: "#a074c4" },
  jpeg: { glyph: "", color: "#a074c4" },
  gif: { glyph: "", color: "#a074c4" },
  el: { glyph: "", color: "#9b59b6" },
};

// Keyed by exact lower-case file name (wins over extension).
const BY_NAME: Record<string, FileIcon> = {
  "package.json": { glyph: "", color: "#cb3837" },
  "package-lock.json": { glyph: "", color: "#cb3837" },
  "cargo.toml": { glyph: "", color: "#dea584" },
  "cargo.lock": { glyph: "", color: "#dea584" },
  ".gitignore": { glyph: "", color: "#f14e32" },
  ".gitattributes": { glyph: "", color: "#f14e32" },
  ".gitmodules": { glyph: "", color: "#f14e32" },
  dockerfile: { glyph: "", color: "#2496ed" },
  makefile: { glyph: "", color: "#6d8086" },
};

/** Glyph + color for a tree/picker entry. Directories ignore the name. */
export function fileIcon(name: string, isDir: boolean, isOpen = false): FileIcon {
  if (isDir) return isOpen ? FOLDER_OPEN : FOLDER_CLOSED;
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  return BY_EXT[ext] ?? GENERIC_FILE;
}
