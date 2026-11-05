// Shared browser runner. Tests use the same CodeMirror/React runtime as the app.
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

export async function runBrowserTests(entry) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "review-me-tests-"));
  let server, browser, deadline;
  try {
    await build({
      root, configFile: false, logLevel: "silent", esbuild: { jsx: "automatic" },
      define: { __APP_VERSION__: '"test"', __APP_BUILT__: "0", "process.env.NODE_ENV": '"test"' },
      build: {
        outDir: dir, emptyOutDir: false, minify: false,
        lib: { entry: join(root, entry), name: "browserTests", formats: ["iife"], fileName: () => "test.js" },
      },
    });
    await copyFile(join(root, "src/styles.css"), join(dir, "test.css"));
    await writeFile(join(dir, "index.html"), `<!doctype html>
      <meta charset="utf-8"><link rel="stylesheet" href="test.css">
      <style>
        .project-viewer { width: 920px; height: 360px; }
        .fixture { display: flex; flex-direction: column; width: 1000px; height: 700px; }
      </style>
      <body><script>
        window.__testErrors = [];
        addEventListener("error", event => window.__testErrors.push(event.message));
        addEventListener("unhandledrejection", event => window.__testErrors.push(String(event.reason)));
        new MutationObserver(() => {
          const output = document.getElementById("test-results");
          if (!output || window.__resultsSent) return;
          window.__resultsSent = true;
          const results = JSON.parse(decodeURIComponent(output.textContent));
          if (window.__testErrors.length) results.push({ name: "uncaught browser errors", error: window.__testErrors.join("\\n") });
          fetch("/results", { method: "POST", body: JSON.stringify(results) });
        }).observe(document.documentElement, { childList: true, subtree: true });
      </script><script src="test.js"></script></body>`);
    // Real browser time lets requestAnimationFrame focus/layout effects complete.
    // A loopback endpoint reports completion without browser automation dependencies.
    let complete, fail;
    const completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    server = createServer(async (request, response) => {
      response.setHeader("Connection", "close");
      try {
        if (request.method === "POST" && request.url === "/results") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          complete(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          response.end("ok");
          return;
        }
        const files = { "/": ["index.html", "text/html"], "/test.js": ["test.js", "text/javascript"], "/test.css": ["test.css", "text/css"] };
        const file = files[request.url];
        if (!file) { response.writeHead(404).end(); return; }
        response.setHeader("Content-Type", `${file[1]}; charset=utf-8`);
        response.end(await readFile(join(dir, file[0])));
      } catch (error) { response.writeHead(500).end(); fail(error); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    let diagnostics = "";
    browser = spawn(process.env.CHROME_BIN || "chromium", [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      `--user-data-dir=${join(dir, "profile")}`, `http://127.0.0.1:${server.address().port}/`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    browser.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    browser.once("error", fail);
    browser.once("exit", code => fail(new Error(`Browser exited (${code}) before reporting results:\n${diagnostics}`)));
    deadline = setTimeout(() => fail(new Error(`Browser tests did not finish within 30 seconds:\n${diagnostics}`)), 30000);
    const results = await completion;
    if (!Array.isArray(results) || results.length === 0 || results.some(r => typeof r.name !== "string")) {
      throw new Error("Browser returned no tests or invalid results");
    }
    for (const result of results) {
      console.log(`${result.error ? "FAIL" : "PASS"} ${result.name}`);
      if (result.error) console.error(result.error);
    }
    console.log(`${entry}: ${results.filter(r => !r.error).length}/${results.length} passed`);
    if (results.some(r => r.error)) process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (browser && browser.exitCode === null) {
      const closed = new Promise(resolve => browser.once("close", resolve));
      browser.kill();
      const force = setTimeout(() => browser.kill("SIGKILL"), 2000);
      await closed;
      clearTimeout(force);
    }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/browser-tests.mjs tests/<suite>.ts[x]");
  await runBrowserTests(process.argv[2]);
}
