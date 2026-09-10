// Catches exactly the bug class that broke the earlier ES-module migration
// attempt: a module calling a function/variable that isn't actually
// declared anywhere it can see.
//
// All 17 files in js/modules-src/ are concatenated by build.py into one
// shared-scope IIFE — that's a deliberate, load-bearing pattern here, not
// an accident to "fix". So this config doesn't lint each file as an
// isolated module; instead it scans every file in js/modules-src/ first,
// collects every top-level function/const/let name any of them declares,
// and treats that whole set as valid globals for every file — because at
// runtime, after concatenation, that's exactly what it is. Anything
// referenced that ISN'T in that set, and isn't a genuine browser/CDN
// global, is either a typo or a real missing dependency — and should fail
// the build.
//
// This list regenerates every time ESLint runs, by reading the actual
// source files — so a new module or a renamed function updates it
// automatically. Nothing here needs to be hand-maintained except the
// browser/CDN globals list below, which only changes if a new CDN library
// gets added.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulesDir = path.join(__dirname, 'js', 'modules-src');

function collectSharedScopeNames() {
  const names = new Set();
  for (const file of fs.readdirSync(modulesDir)) {
    if (!file.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(modulesDir, file), 'utf8');
    for (const m of text.matchAll(/^\s*(?:async\s+function|function)\s+([A-Za-z0-9_$]+)\s*\(/gm)) {
      names.add(m[1]);
    }
    // Matches every name in a `const`/`let` statement, including
    // comma-separated multi-declarations on one line
    // (`let a = 1, b = 2, c;`) — a single-name-only version of this regex
    // missed `sigTechPad` in service-report.js's
    // `let sigCustomerPad = null, sigTechPad = null, sigPadsPromise = null;`
    // and produced a false "undefined" report.
    for (const stmt of text.matchAll(/^\s*(?:const|let)\s+(.+?);?\s*$/gm)) {
      for (const nm of stmt[1].matchAll(/(?:^|,)\s*([A-Za-z0-9_$]+)\s*(?:=[^,]*)?(?=,|$)/g)) {
        names.add(nm[1]);
      }
    }
  }
  return names;
}

const sharedScopeGlobals = Object.fromEntries(
  [...collectSharedScopeNames()].map(name => [name, 'writable'])
);

export default [
  {
    files: ['js/modules-src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Standard browser/runtime globals
        window: 'readonly', document: 'readonly', console: 'readonly',
        navigator: 'readonly', location: 'readonly', history: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly',
        fetch: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        Promise: 'readonly', crypto: 'readonly',
        FileReader: 'readonly', Blob: 'readonly', File: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly',
        Image: 'readonly', CustomEvent: 'readonly', Event: 'readonly',
        FormData: 'readonly', XMLHttpRequest: 'readonly',
        IntersectionObserver: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly',
        AbortController: 'readonly', structuredClone: 'readonly',
        atob: 'readonly', btoa: 'readonly',
        Uint8Array: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
        performance: 'readonly', matchMedia: 'readonly', getComputedStyle: 'readonly',
        self: 'readonly', globalThis: 'readonly',
        CSS: 'readonly', createImageBitmap: 'readonly',
        // App-specific globals — defined once in index.html or by a CDN
        // script tag, then referenced bare across modules
        loadAwesScript: 'readonly', loadAwesCss: 'readonly',
        awesLibs: 'readonly', awesCss: 'readonly',
        emailjs: 'readonly', Tesseract: 'readonly',
        SignaturePad: 'readonly', pdfjsLib: 'readonly',
        // window.storage is set up in index.html; browsers expose window
        // properties as bare globals in classic (non-module) scripts
        storage: 'readonly',
        // Everything any of the 17 modules declares at top level —
        // computed above, since after build.py concatenates them, they
        // all share one real scope
        ...sharedScopeGlobals
      }
    },
    rules: {
      // The one rule this config exists for: every identifier must resolve
      // to something declared (in this file, another concatenated module,
      // or a listed global above). This is what would have caught the
      // esbuild tree-shaking bug from the ES-module migration attempt.
      'no-undef': 'error',
      'no-unused-vars': 'off' // noise for this codebase's size — not what we're checking for
    }
  }
];
