// Lint rules for Shellby. Four environments live in this repo and each gets the
// globals it actually has, so a typo in one can't pass because another defines
// the name:
//
//   src/main, src/preload  Node + Electron (CommonJS)
//   src/renderer           the browser, with no Node at all (sandboxed) and the
//                          SB namespace the panel's files share
//   scripts, test          Node, plus fetch/WebSocket from Node 22
//
// Style is left alone on purpose: this is here to catch mistakes (an unused
// variable left behind by an edit, a misspelled global, a case that falls
// through), not to reformat a codebase that reads consistently already.
import js from '@eslint/js';

const RULES = {
  // The real point of all this: a name that doesn't exist anywhere.
  'no-undef': 'error',
  // Args are often there for shape (_e, _unused); leading _ opts out.
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-fallthrough': 'error',
  'no-self-compare': 'error',
  'no-unreachable-loop': 'error',
  // `catch { /* gone */ }` is this codebase's way of saying "this is fine", and
  // it says it hundreds of times.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // `new Promise(r => setTimeout(r, ms))` is the local idiom for sleeping; the
  // returned timer id is nobody's business.
  'no-promise-executor-return': 'off',
  // Tests and the status line deal in real control characters on purpose.
  'no-control-regex': 'off',
  // Several regexes here exist precisely to strip a BOM or a zero-width
  // character, so the "irregular" whitespace in them is the subject, not a slip.
  'no-irregular-whitespace': 'off',
  // statusline.js embeds a bash snippet whose ${…} belong to bash.
  'no-template-curly-in-string': 'off',
  // core.js is the file that declares the SB namespace the others read.
  'no-redeclare': ['error', { builtinGlobals: false }],
  'require-atomic-updates': 'off', // too noisy on async IPC handlers that await a dialog
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
};

const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly',
  TextDecoder: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', fetch: 'readonly',
  WebSocket: 'readonly', structuredClone: 'readonly', global: 'readonly', queueMicrotask: 'readonly',
  Response: 'readonly', Request: 'readonly', Headers: 'readonly', Blob: 'readonly', FormData: 'readonly',
  performance: 'readonly', crypto: 'readonly',
};

// What a sandboxed renderer really has. No require, no process.
const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  matchMedia: 'readonly', getComputedStyle: 'readonly', ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly', MutationObserver: 'readonly', Image: 'readonly',
  Audio: 'readonly', XMLSerializer: 'readonly', AudioContext: 'readonly', Blob: 'readonly', File: 'readonly',
  FileReader: 'readonly', FormData: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  fetch: 'readonly', Event: 'readonly', CustomEvent: 'readonly', DOMParser: 'readonly',
  HTMLElement: 'readonly', SVGElement: 'readonly', Node: 'readonly', devicePixelRatio: 'readonly',
  performance: 'readonly', crypto: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly',
  // Shellby's own: the preload bridge, and the namespace the panel's files share.
  shellby: 'readonly', SB: 'writable', ShellbyChirp: 'writable',
};

export default [
  { ignores: ['node_modules/**', 'dist/**', 'packaging/**', '.claude-flow/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: NODE_GLOBALS },
    rules: RULES,
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: BROWSER_GLOBALS },
    rules: RULES,
  },
  {
    // Test files and the e2e drivers evaluate renderer code as strings; the
    // names inside those strings are not theirs to resolve.
    files: ['test/**/*.js', 'scripts/**/*.js'],
    rules: { ...RULES, 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }] },
  },
];
