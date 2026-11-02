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
    "$root", "$data", "$router", "$route", "$t", "$any", "$index", "$first", "$last",
    "$even", "$odd", "$count", "$implicit",
    // Astro's.
    "Astro",
];

pub fn is_global(name: &str) -> bool {
    GLOBALS.contains(&name)
}

/// Elements that are a framework's own rather than a component of the project's —
/// lowercase HTML ones aside, which never are.
const BUILTIN_COMPONENTS: &[&str] = &[
    "Component", "Transition", "TransitionGroup", "KeepAlive", "Teleport", "Suspense",
    "RouterView", "RouterLink", "NuxtLink", "NuxtPage", "NuxtLayout", "NuxtRouteAnnouncer",
    "NuxtLoadingIndicator", "NuxtErrorBoundary", "NuxtWelcome", "NuxtImg", "NuxtPicture",
    "NuxtIsland", "NuxtClientFallback", "ClientOnly", "DevOnly", "ServerPlaceholder", "Slot",
    "Template", "Fragment", "Head", "Html", "Body", "Title", "Meta", "Link", "Style",
    "NoScript", "Base",
];

pub fn is_builtin_component(name: &str) -> bool {
    BUILTIN_COMPONENTS.contains(&name)
}

/// What Vue, its router and Nuxt auto-import in an app that auto-imports.
const AUTO_IMPORTED: &[&str] = &[
    // Vue.
    "ref", "shallowRef", "triggerRef", "customRef", "unref", "isRef", "toRef", "toRefs",
    "toValue", "reactive", "shallowReactive", "readonly", "shallowReadonly", "isReactive",
    "isReadonly", "isProxy", "toRaw", "markRaw", "computed", "watch", "watchEffect",
    "watchPostEffect", "watchSyncEffect", "effectScope", "getCurrentScope", "onScopeDispose",
    "onMounted", "onUpdated", "onUnmounted", "onBeforeMount", "onBeforeUpdate",
    "onBeforeUnmount", "onErrorCaptured", "onActivated", "onDeactivated", "onServerPrefetch",
    "nextTick", "provide", "inject", "h", "defineComponent", "defineAsyncComponent",
    "getCurrentInstance", "useAttrs", "useSlots", "useCssModule", "useCssVars", "useId",
    "useTemplateRef", "useModel", "resolveComponent",
    // Vue Router.
    "useRoute", "useRouter", "onBeforeRouteLeave", "onBeforeRouteUpdate",
    // Nuxt.
    "useFetch", "useLazyFetch", "useAsyncData", "useLazyAsyncData", "refreshNuxtData",
    "clearNuxtData", "useState", "clearNuxtState", "navigateTo", "abortNavigation",
    "useHead", "useHeadSafe", "useSeoMeta", "useServerSeoMeta", "definePageMeta",
    "defineNuxtPlugin", "defineNuxtRouteMiddleware", "addRouteMiddleware", "useRuntimeConfig",
    "useAppConfig", "useNuxtApp", "useCookie", "useRequestHeaders", "useRequestHeader",
    "useRequestEvent", "useRequestURL", "useRequestFetch", "useError", "createError",
    "showError", "clearError", "useRouteAnnouncer", "useLoadingIndicator", "useNuxtData",
    "useHydration", "callOnce", "onNuxtReady", "prefetchComponents", "preloadComponents",
    "preloadRouteComponents", "reloadNuxtApp", "setPageLayout", "setResponseStatus",
    "updateAppConfig", "defineNuxtComponent", "defineAppConfig", "defineNuxtConfig",
    "useI18n", "$fetch",
    // Nitro, in `server/`.
    "defineEventHandler", "eventHandler", "readBody", "getQuery", "getRouterParam",
    "getRouterParams", "getCookie", "setCookie", "deleteCookie", "getHeader", "setHeader",
    "sendRedirect", "useStorage", "defineNitroPlugin", "defineCachedEventHandler",
    "defineCachedFunction", "useNitroApp",
];

pub fn is_auto_imported(name: &str) -> bool {
    AUTO_IMPORTED.contains(&name)
}
