import { unzip } from 'fflate'
import sqlWasmScriptUrl from 'sql.js/dist/sql-wasm.js?url'
import sqlWasmBinaryUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { InitSqlJsStatic, SqlJsConfig, SqlJsStatic } from 'sql.js'

declare global {
  interface Window {
    initSqlJs?: InitSqlJsStatic
  }
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined

const isInitFunction = (value: unknown): value is InitSqlJsStatic =>
  typeof value === 'function' &&
  typeof (value as InitSqlJsStatic).default === 'function'

const loadSqlJsScript = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('APKG parser requires a browser environment'))
      return
    }

    const existing = document.querySelector('script[data-sql-js]') as HTMLScriptElement | null
    if (existing !== null && existing.dataset.loaded === 'true') {
      resolve()
      return
    }
    if (existing !== null) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Failed to load sql.js')))
      return
    }

    const script = document.createElement('script')
    script.src = sqlWasmScriptUrl
    script.async = true
    script.dataset.sqlJs = 'true'
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true'
      resolve()
    })
    script.addEventListener('error', () => reject(new Error('Failed to load sql.js')))
    document.body.appendChild(script)
  })
}

const resolveInitFunction = async (): Promise<InitSqlJsStatic> => {
  if (window.initSqlJs !== undefined) {
    return window.initSqlJs
  }

  let module: unknown
  try {
    module = (await import('sql.js/dist/sql-wasm.js')) as unknown
  } catch {
    throw new Error('sql.js module could not be loaded')
  }

  if (isInitFunction(module)) {
    return module
  }

  if (module !== null && typeof module === 'object') {
    const mod = module as { default?: unknown; initSqlJs?: unknown }
    const candidate = mod.default ?? mod.initSqlJs
    if (isInitFunction(candidate)) {
      return candidate
    }
  }

  throw new Error('sql.js module could not be loaded')
}

const initSqlJs = async (): Promise<SqlJsStatic> => {
  await loadSqlJsScript()
  const factory = await resolveInitFunction()
  const config: SqlJsConfig = { locateFile: () => sqlWasmBinaryUrl }
  return factory(config)
}

const getSqlJs = (): Promise<SqlJsStatic> => {
  if (sqlJsPromise === undefined) {
    sqlJsPromise = initSqlJs()
  }
  return sqlJsPromise
}

const extractFirstField = (flds: string): string | undefined => {
  const first = flds.split('\u001f')[0]
  if (first === undefined) return undefined
  const trimmed = first.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const unzipFile = (buffer: Uint8Array): Promise<Record<string, Uint8Array>> => {
  return new Promise((resolve, reject) => {
    unzip(buffer, (err, files) => (err !== null ? reject(err) : resolve(files ?? {})))
  })
}

export async function parseApkg(file: File): Promise<string[]> {
  if (typeof document === 'undefined') {
    throw new Error('APKG import is only available in the browser')
  }

  const buffer = new Uint8Array(await file.arrayBuffer())
  const files = await unzipFile(buffer)
  const collection = files['collection.anki2']

  if (collection === undefined) {
    throw new Error('collection.anki2 が見つかりません。有効な .apkg ファイルを選択してください。')
  }

  const SQL = await getSqlJs()
  const db = new SQL.Database(collection)

  try {
    const result = db.exec('SELECT flds FROM notes')
    const rows = result[0]?.values ?? []
    const words: string[] = []

    for (const row of rows) {
      const flds = row[0]
      if (typeof flds !== 'string') continue
      const word = extractFirstField(flds)
      if (word !== undefined) words.push(word)
    }

    return [...new Set(words)]
  } finally {
    db.close()
  }
}
