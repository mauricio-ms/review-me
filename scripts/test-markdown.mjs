// Browser regressions for CodeMirror layout, using Vite and the installed Chromium.
// Override CHROME_BIN when Chromium has a different executable name.
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "review-me-markdown-"));
try {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    define: {
      __APP_VERSION__: '"test"', __APP_BUILT__: "0", "process.env.NODE_ENV": '"test"',
    },
    build: {
      outDir: dir,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: join(root, "tests/markdown-view.ts"),
        name: "markdownTests",
        formats: ["iife"],
        fileName: () => "test.js",
      },
    },
  });
  await copyFile(join(root, "src/styles.css"), join(dir, "test.css"));
  await writeFile(join(dir, "index.html"), `<!doctype html>
    <link rel="stylesheet" href="test.css">
    <style>.project-viewer { width: 920px; height: 360px; }</style>
    <body><script src="test.js"></script></body>`);
  const browser = spawnSync(process.env.CHROME_BIN || "chromium", [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    `--user-data-dir=${join(dir, "profile")}`, "--allow-file-access-from-files",
    "--virtual-time-budget=15000", "--dump-dom", `file://${join(dir, "index.html")}`,
  ], { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const encoded = browser.stdout?.match(/<pre id="test-results">([^<]*)<\/pre>/)?.[1];
  if (browser.error || browser.status !== 0 || !encoded) {
    throw new Error(browser.error?.message || browser.stderr || "Browser tests did not finish");
  }
  const results = JSON.parse(decodeURIComponent(encoded));
  for (const result of results) {
    console.log(`${result.error ? "FAIL" : "PASS"} ${result.name}`);
    if (result.error) console.error(result.error);
  }
  if (results.some((result) => result.error)) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
