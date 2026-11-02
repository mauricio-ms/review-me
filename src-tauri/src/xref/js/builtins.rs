//! Names every JavaScript program can use without declaring them: the language's and
//! the runtimes' globals, test runners', and frameworks' compiler macros. A name found
//! nowhere in the project but listed here is provably someone else's.

const GLOBALS: &[&str] = &[
    // The language.
    "globalThis", "undefined", "NaN", "Infinity", "eval", "isFinite", "isNaN", "parseFloat",
    "parseInt", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent",
    "escape", "unescape", "Object", "Function", "Boolean", "Symbol", "Error",
    "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
    "TypeError", "URIError", "Number", "BigInt", "Math", "Date", "String", "RegExp",
    "Array", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array",
    "BigUint64Array", "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
    "FinalizationRegistry", "ArrayBuffer", "SharedArrayBuffer", "Atomics", "DataView",
    "JSON", "Promise", "Proxy", "Reflect", "Intl", "Iterator", "arguments",
    // Browsers.
    "window", "self", "document", "navigator", "location", "history", "screen",
    "console", "alert", "confirm", "prompt", "fetch", "Request", "Response", "Headers",
    "FormData", "URL", "URLSearchParams", "Blob", "File", "FileReader", "WebSocket",
    "Worker", "SharedWorker", "EventSource", "XMLHttpRequest", "AbortController",
    "AbortSignal", "Event", "CustomEvent", "EventTarget", "KeyboardEvent", "MouseEvent",
    "PointerEvent", "TouchEvent", "FocusEvent", "InputEvent", "WheelEvent",
    "DragEvent", "ClipboardEvent", "MessageEvent", "MessageChannel", "BroadcastChannel",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate",
    "clearImmediate", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
    "requestIdleCallback", "cancelIdleCallback", "structuredClone", "atob", "btoa",
    "localStorage", "sessionStorage", "indexedDB", "crypto", "performance", "caches",
    "matchMedia", "getComputedStyle", "scrollTo", "scrollBy", "open", "close", "print",
    "innerWidth", "innerHeight", "outerWidth", "outerHeight", "scrollX", "scrollY",
    "devicePixelRatio", "origin", "customElements", "Node", "Element", "HTMLElement",
    "SVGElement", "Text", "Comment", "DocumentFragment", "Range", "Selection",
    "MutationObserver", "IntersectionObserver", "ResizeObserver", "PerformanceObserver",
    "Image", "Audio", "Option", "TextEncoder", "TextDecoder", "ReadableStream",
    "WritableStream", "TransformStream", "CompressionStream", "DecompressionStream",
    "Notification", "ServiceWorker", "Cache", "CSS", "DOMParser", "XMLSerializer",
    "getSelection", "postMessage", "addEventListener", "removeEventListener",
    "dispatchEvent", "reportError", "IDBKeyRange", "WebAssembly",
    // Node and other runtimes.
    "process", "Buffer", "global", "require", "module", "exports", "__dirname",
    "__filename", "Deno", "Bun",
    // Test runners.
    "describe", "it", "test", "expect", "beforeAll", "beforeEach", "afterAll",
    "afterEach", "jest", "vi", "suite", "context", "cy", "Cypress", "assert",
    // Framework compiler macros: Vue's `<script setup>`, Svelte's runes.
    "defineProps", "defineEmits", "defineExpose", "defineOptions", "defineSlots",
    "defineModel", "withDefaults", "$state", "$derived", "$effect", "$props",
    "$bindable", "$inspect", "$host",
    // Template-only names: Vue's event and helpers, Angular's.
    "$event", "$attrs", "$slots", "$refs", "$emit", "$props", "$el", "$parent",
    "$root", "$data", "$router", "$route", "$t", "$any",
];

pub fn is_global(name: &str) -> bool {
    GLOBALS.contains(&name)
}
