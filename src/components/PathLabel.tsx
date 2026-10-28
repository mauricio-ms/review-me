import { Fragment, type ReactNode } from "react";

/** `src/main/Foo.java` → `["src/main/", "Foo.java"]`. */
export function splitPath(path: string): [dir: string, base: string] {
  const cut = path.lastIndexOf("/") + 1;
  return [path.slice(0, cut), path.slice(cut)];
}

/**
 * A rename the way git writes it: the shared folders once, the part that moved in
 * braces — `src/{model/Item.java → catalog/CatalogItem.java}`, or
 * `src/{a → b}/Foo.java` when only a folder changed.
 */
export function renameParts(
  from: string,
  to: string,
): { prefix: string; from: string; to: string; suffix: string } {
  const a = from.split("/");
  const b = to.split("/");
  let p = 0;
  while (p < a.length - 1 && p < b.length - 1 && a[p] === b[p]) p++;
  let s = 0;
  while (
    s < a.length - p - 1 &&
    s < b.length - p - 1 &&
    a[a.length - 1 - s] === b[b.length - 1 - s]
  ) {
    s++;
  }
  return {
    prefix: p > 0 ? `${a.slice(0, p).join("/")}/` : "",
    from: a.slice(p, a.length - s).join("/"),
    to: b.slice(p, b.length - s).join("/"),
    suffix: s > 0 ? `/${a.slice(a.length - s).join("/")}` : "",
  };
}

/** `dir` with a break opportunity after every `/`: a wrapped path breaks between folders. */
function breakable(text: string): ReactNode {
  const parts = text.split("/");
  return parts.map((part, i) =>
    i < parts.length - 1 ? (
      <Fragment key={i}>
        {part}/<wbr />
      </Fragment>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

type Props = {
  path: string;
  /** The path before a rename; shown git-style (`wrap` mode only). */
  oldPath?: string | null;
  /**
   * `wrap` (where the path is read: diff rows, headers) breaks between folders and
   * never hides anything. `elide` (one-line lists) keeps the file name whole and
   * shortens the folders from the left: `…/library/service/Foo.java`.
   */
  mode?: "wrap" | "elide";
  className?: string;
};

/**
 * A repo path whose file name is the part you read: folders dimmed, name bright, and
 * never cut off at the name — the old right-hand ellipsis hid exactly that.
 */
export default function PathLabel({ path, oldPath, mode = "wrap", className }: Props) {
  const cls = `path is-${mode}${className ? ` ${className}` : ""}`;

  if (mode === "elide") {
    const [dir, base] = splitPath(path);
    return (
      <span className={cls} title={oldPath ? `${oldPath} → ${path}` : path}>
        {dir && (
          <span className="path-dir">
            <bdi>{dir}</bdi>
          </span>
        )}
        <span className="path-base">{base}</span>
      </span>
    );
  }

  if (oldPath && oldPath !== path) {
    const parts = renameParts(oldPath, path);
    const braces = !!(parts.prefix || parts.suffix);
    // The new file name is the part to read: in the moved part, or in the suffix when
    // only folders changed.
    const [toDir, toBase] = parts.suffix ? [parts.to, ""] : splitPath(parts.to);
    const [suffixDir, suffixBase] = splitPath(parts.suffix);
    return (
      <span className={cls}>
        <span className="path-dir">
          {breakable(parts.prefix)}
          {braces && "{"}
          {breakable(parts.from)}
        </span>
        <span className="path-arrow"> → </span>
        <span className="path-dir">{breakable(toDir)}</span>
        {toBase && <span className="path-base">{toBase}</span>}
        {braces && (
          <span className="path-dir">
            {"}"}
            {breakable(suffixDir)}
          </span>
        )}
        {suffixBase && <span className="path-base">{suffixBase}</span>}
      </span>
    );
  }

  const [dir, base] = splitPath(path);
  return (
    <span className={cls}>
      {dir && <span className="path-dir">{breakable(dir)}</span>}
      <span className="path-base">{base}</span>
    </span>
  );
}
