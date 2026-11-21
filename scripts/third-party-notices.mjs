#!/usr/bin/env node
// third-party-notices.mjs — collect the licenses of everything a release build ships.
//
//   node scripts/third-party-notices.mjs [output]    (default: THIRD-PARTY-NOTICES.txt)
//
// Two sources: the Rust crates linked into the binary (cargo metadata's resolved graph,
// following normal dependencies only, since build scripts and dev-dependencies aren't
// shipped), and the npm packages the frontend needs at runtime (package-lock.json entries
// not marked dev). Each package's own license files are copied verbatim. Packages whose
// texts are identical are listed together above one copy, so a shared Apache-2.0 text
// appears once while every MIT text keeps its own copyright line. A package that ships
// no license file is listed at the end with its declared license and where to find it.
//
// .github/workflows/release.yml runs this before building and puts the result in every
// package and on the release page.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "THIRD-PARTY-NOTICES.txt"));

const LICENSE_NAME = /^(licen[cs]e|copying|notice|copyright|unlicense)([-._][\w.-]*)?$/i;
const SOURCE_FILE = /\.(c?js|mjs|ts|rs|json|map|html?)$/i;

/** The license texts in a package directory, plus a declared `license_file`. */
function licenseTexts(dir, declared) {
  const names = new Set(
    readdirSync(dir).filter(
      (name) =>
        LICENSE_NAME.test(name) &&
        !SOURCE_FILE.test(name) &&
        statSync(join(dir, name)).isFile(),
    ),
  );
  if (declared && existsSync(join(dir, declared))) names.add(declared);
  return [...names]
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n").trim())
    .filter((text) => text.length > 0);
}

function repositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) return null;
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function rustCrates() {
  const host = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version=1",
        "--locked",
        `--filter-platform=${host}`,
        `--manifest-path=${join(root, "src-tauri", "Cargo.toml")}`,
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const app = metadata.resolve.root;
  const shipped = new Set();
  const queue = [app];
  while (queue.length > 0) {
    for (const dep of nodes.get(queue.pop()).deps) {
      const normal = dep.dep_kinds.some((k) => k.kind === null);
      if (!normal || shipped.has(dep.pkg) || dep.pkg === app) continue;
      shipped.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  return [...shipped].map((id) => {
    const p = packages.get(id);
    return {
      kind: "crate",
      name: p.name,
      version: p.version,
      license: p.license ?? "see its license file",
      url: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
      texts: licenseTexts(dirname(p.manifest_path), p.license_file),
    };
  });
}

function npmPackages() {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const found = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/") || entry.dev || entry.devOptional) continue;
    const dir = join(root, path);
    if (!existsSync(join(dir, "package.json"))) continue; // an optional package for another platform
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    found.push({
      kind: "npm",
      name,
      version: manifest.version ?? entry.version,
      license: manifest.license ?? entry.license ?? "see its license file",
      url: repositoryUrl(manifest.repository) ?? manifest.homepage ?? `https://www.npmjs.com/package/${name}`,
      texts: licenseTexts(dir),
    });
  }
  return found;
}

const all = [...rustCrates(), ...npmPackages()].sort(
  (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);

const groups = new Map();
const without = [];
for (const p of all) {
  if (p.texts.length === 0) {
    without.push(p);
    continue;
  }
  const key = createHash("sha256").update(p.texts.join("\0")).digest("hex");
  if (!groups.has(key)) groups.set(key, { texts: p.texts, packages: [] });
  groups.get(key).packages.push(p);
}

const RULE = "=".repeat(80);
const THIN = "-".repeat(80);
const line = (p) => `${p.kind} ${p.name} ${p.version} (${p.license}): ${p.url}`;
const crates = all.filter((p) => p.kind === "crate").length;

let text = `review-me third-party notices

review-me is distributed under the MIT License (see LICENSE). It includes the
third-party software listed below: ${crates} Rust crates and ${all.length - crates} npm packages.
Each license text is reproduced from the packages that carry it; the packages
listed above a text are distributed under it.
`;
for (const group of groups.values()) {
  text += `\n${RULE}\n${group.packages.map(line).join("\n")}\n${THIN}\n\n${group.texts.join(`\n\n${THIN}\n\n`)}\n`;
}
if (without.length > 0) {
  text += `\n${RULE}\nThese packages ship no license file of their own. Each is distributed under the\nlicense it declares; its full text is available from the address given.\n${THIN}\n${without.map(line).join("\n")}\n`;
}
writeFileSync(output, text);
console.error(
  `${relative(process.cwd(), output) || output}: ${all.length} packages, ${groups.size} distinct license texts, ${without.length} without a license file`,
);
