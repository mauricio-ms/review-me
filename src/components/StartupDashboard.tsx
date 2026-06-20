const GLASS_GLYPH = [
  "011110000",
  "110011000",
  "100001000",
  "100001000",
  "110011000",
  "011111000",
  "000011100",
  "000001110",
  "000000110",
] as const;

function PixelGlyph({
  glyph,
  className,
}: {
  glyph: readonly string[];
  className?: string;
}) {
  const columns = glyph[0]?.length ?? 0;

  return (
    <span
      className={`startup-pixel-glyph ${className ?? ""}`}
      style={{
        gridTemplateColumns: `repeat(${columns}, var(--startup-logo-pixel))`,
        gridTemplateRows: `repeat(${glyph.length}, var(--startup-logo-pixel))`,
      }}
    >
      {glyph.map((row, rowIndex) =>
        Array.from(row).map((cell, columnIndex) => (
          <span
            key={`${rowIndex}-${columnIndex}`}
            className={`startup-logo-pixel ${cell === "1" ? "is-on" : ""}`}
          />
        )),
      )}
    </span>
  );
}

// 5×7 pixel glyphs for the wordmark, drawn in the same grid style as the logo
// mark so the title reads as pixel-art rather than a system font.
const PIXEL_FONT: Record<string, readonly string[]> = {
  r: ["00000", "00000", "10100", "11000", "10000", "10000", "10000"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
  v: ["00000", "00000", "10001", "10001", "10001", "01010", "00100"],
  i: ["00100", "00000", "00100", "00100", "00100", "00100", "00100"],
  w: ["00000", "00000", "10001", "10001", "10101", "10101", "01010"],
  m: ["00000", "00000", "11111", "10101", "10101", "10101", "10101"],
  "-": ["00000", "00000", "00000", "00000", "01110", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function PixelWord({ text, className }: { text: string; className?: string }) {
  return (
    <span
      className={`startup-pixel-word ${className ?? ""}`}
      role="img"
      aria-label={text}
    >
      {Array.from(text).map((char, index) => (
        <PixelGlyph key={index} glyph={PIXEL_FONT[char] ?? PIXEL_FONT[" "]} />
      ))}
    </span>
  );
}

export default function StartupDashboard() {
  return (
    <div className="startup-dashboard" tabIndex={-1}>
      <div className="startup-inner">
        <div className="startup-logo">
          <span className="startup-logo-mark" aria-hidden="true">
            <PixelGlyph glyph={GLASS_GLYPH} className="startup-logo-glass" />
          </span>
          <PixelWord text="review-me" className="startup-logo-word" />
        </div>
        <div className="startup-menu">
          <div className="startup-menu-row">
            <kbd>Space</kbd>
            <span>command palette</span>
          </div>
          <div className="startup-menu-row">
            <kbd>o</kbd>
            <kbd>p</kbd>
            <span>open repository</span>
          </div>
          <div className="startup-menu-row">
            <kbd>o</kbd>
            <kbd>r</kbd>
            <span>recent repositories</span>
          </div>
          <div className="startup-menu-row">
            <kbd>:</kbd>
            <span>command line</span>
          </div>
        </div>
      </div>
    </div>
  );
}
