# Agent notes for lime

## Verification

- `pnpm build` — TypeScript + Vite production build.
- `pnpm test` — Vitest test suite.

## Notes

- APKG import uses `sql.js` to read `collection.anki2`. The wasm and JS are
  loaded as Vite `?url` assets from `sql.js/dist/sql-wasm.*`; the parser first
  tries a global `<script>` and falls back to a dynamic ESM import.
