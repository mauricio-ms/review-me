import type { ChangedFile } from "../types/diff";
import type { TreeEntry } from "../types/repo";

/** A tree row; `change` is set on the files of the changed-files view. */
export type TreeNode = { entry: TreeEntry; depth: number; change?: ChangedFile };

/** Case-insensitive name order — the backend's `tree::list_dir` sort. */
function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The changed-files view: a tree synthesized from the comparison's own paths (it has
 * every file it needs, so nothing is listed from disk), folders first and open unless
 * the reviewer folded them.
 */
export function buildChanged(files: ChangedFile[], collapsed: Set<string>): TreeNode[] {
  type Dir = { dirs: Map<string, Dir>; files: ChangedFile[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const file of files) {
    let dir = root;
    for (const part of file.path.split("/").slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const out: TreeNode[] = [];
  const walk = (dir: Dir, prefix: string, depth: number) => {
    for (const [dirName, first] of [...dir.dirs].sort(([a], [b]) => byName(a, b))) {
      // A folder holding just one folder is one row (`java/com/acme`), as the full
      // listing compacts it (`tree::list_dir`).
      let child = first;
      let label = dirName;
      let path = prefix ? `${prefix}/${dirName}` : dirName;
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [[innerName, inner]] = [...child.dirs];
        label = `${label}/${innerName}`;
        path = `${path}/${innerName}`;
        child = inner;
      }
      out.push({ entry: { name: label, path, isDir: true }, depth });
      if (!collapsed.has(path)) walk(child, path, depth + 1);
    }
    for (const file of [...dir.files].sort((a, b) => byName(name(a.path), name(b.path)))) {
      out.push({
        entry: { name: name(file.path), path: file.path, isDir: false },
        depth,
        change: file,
      });
    }
  };
  walk(root, "", 0);
  return out;
}

/**
 * The comparison's files in the order the changed-files tree lists them — folders
 * first, by name — which is the order `] f` / `[ f` walk them in a file.
 */
export function changedFileOrder(files: ChangedFile[]): ChangedFile[] {
  return buildChanged(files, new Set()).flatMap((node) => (node.change ? [node.change] : []));
}
