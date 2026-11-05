type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const before: Array<() => void | Promise<void>> = [];
const after: Array<() => void | Promise<void>> = [];

export const test = (name: string, run: Test["run"]) => tests.push({ name, run });
export const beforeEach = (run: Test["run"]) => before.push(run);
export const afterEach = (run: Test["run"]) => after.push(run);
export function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
export function equal(actual: unknown, expected: unknown) {
  const json = (value: unknown) => JSON.stringify(value, (_key, v) =>
    v instanceof Set ? [...v] : v instanceof Map ? [...v.entries()] : v);
  assert(json(actual) === json(expected), `Expected ${json(expected)}, got ${json(actual)}`);
}
export async function rejects(run: () => Promise<unknown>, message: string) {
  try { await run(); } catch (error) {
    assert(String(error).includes(message), `Expected error containing ${message}, got ${String(error)}`);
    return;
  }
  throw new Error(`Expected rejection containing ${message}`);
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function waitFor(condition: () => unknown, message = "Condition did not become true") {
  const end = Date.now() + 1500;
  while (!condition()) {
    assert(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown | Promise<unknown>;
const handlers = new Map<string, Handler>();
export const calls: Array<{ command: string; args: Args }> = [];
export const mock = (command: string, handler: Handler) => handlers.set(command, handler);
export function resetIPC() { handlers.clear(); calls.length = 0; }
// Install before application imports execute. Unconfigured IPC is always a test failure,
// even when an application background task deliberately catches its own errors.
const unexpected: string[] = [];
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: Args = {}) => {
  calls.push({ command, args });
  const handler = handlers.get(command);
  if (!handler) {
    const message = `Unexpected IPC command: ${command}`;
    unexpected.push(message);
    throw new Error(message);
  }
  return handler(args);
} } });
// Some application modules ask this once at import time.
mock("xref_extensions", () => []);

export async function run() {
  const results: Array<{ name: string; error?: string }> = [];
  const errors: string[] = (window as Window & { __testErrors?: string[] }).__testErrors ?? [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); originalError(...args); };
  for (const entry of tests) {
    let error: string | undefined;
    try {
      for (const setup of before) await setup();
      await entry.run();
      // Drain React effects and rejected promises before checking global errors.
      await new Promise(resolve => setTimeout(resolve, 0));
    } catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); }
    finally {
      for (const cleanup of [...after].reverse()) {
        try { await cleanup(); } catch (caught) { error = [error, String(caught)].filter(Boolean).join("\n"); }
      }
      const messages = [...errors.splice(0), ...unexpected.splice(0)];
      if (messages.length) error = [error, ...messages].filter(Boolean).join("\n");
    }
    results.push({ name: entry.name, ...(error ? { error } : {}) });
  }
  console.error = originalError;
  const output = document.body.appendChild(document.createElement("pre"));
  output.id = "test-results";
  output.textContent = encodeURIComponent(JSON.stringify(results));
}
