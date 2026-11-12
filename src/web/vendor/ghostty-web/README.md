# ghostty-web 0.4.0, vendored

The terminal emulator on a machine's shell page
(`src/web/machine-term-client.ts`, `docs/features/machines.md`). Copied
unmodified from the npm package `ghostty-web@0.4.0`
(sha512 `0puDBik2qapbD/QQBW9o5ZHfXnZBqZWx/ctBiVtKZ6ZLds4NYb+wZuw1cRLXZk9zYovIQ908z3rvFhexAvc5Hg==`),
MIT, Copyright (c) 2025 Coder — see `LICENSE`.

| file | from the package | bytes | sha256 |
| --- | --- | --- | --- |
| `ghostty-web.js` | `dist/ghostty-web.js` | 681918 | `078b3fe37e4ef469d3f3d7772ee263070f8613e5a6f5ff305c85778907f45e72` |
| `__vite-browser-external-2447137e.js` | `dist/` (imported by the above) | 41 | `f8c456031e5001c0cda4837cd9ee3a33d79beeba120ec633ec9d990632fb2aa6` |
| `ghostty-vt.wasm` | `ghostty-vt.wasm` | 423045 | `d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a` |
| `ghostty-web.d.ts` | `dist/index.d.ts` | 55510 | `2848adffa959ead3be5fa7a59a664518b0c679f8174fc4b216a1141bfee46861` |
| `LICENSE` | `LICENSE` | 1062 | `5eccd0eeca906db6d661b64dd05e1d4a4b2e49d37d43bbcfd2c8cce4d7832920` |

Nothing here is edited. `src/web/machine-term-asset.ts` bundles the module
with `Bun.build` and, at build time, drops its inlined base64 copy of the
WebAssembly (the page fetches `ghostty-vt.wasm` as its own immutable asset),
so the browser downloads about 75 KB of script and 423 KB of WebAssembly.

To move to a new version: replace these files from the new package, update
this table, and run `bun test test/machine-shell-page.test.ts` (it fails if
the inlined copy is no longer found and dropped).
