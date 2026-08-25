import { Check, ClipboardPaste, FileText, Loader2, Upload } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { DictionaryImportSummary, DictionarySource } from '../dictionary/types'
import type { DictionaryImportApplication } from '../import-service'

type ImportSource = {
  id: string
  name: string
  hint: string
}

const sources: ImportSource[] = [
  { id: 'eijiro', name: '英辞郎', hint: 'BOOTH 版テキスト (.txt)' },
  { id: 'wiktionary', name: 'Wiktionary', hint: 'kaikki.org wiktextract JSONL (.jsonl)' },
  { id: 'yomitan', name: 'Yomitan', hint: 'Yomitan 辞書 (.zip)' },
]

const fileSources = new Set(['yomitan'])

type ImportSectionProps = {
  application?: DictionaryImportApplication
}

export function ImportSection({ application }: ImportSectionProps) {
  const [selectedSource, setSelectedSource] = useState(sources[0].id)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [textSource, setTextSource] = useState<'file' | 'clipboard' | null>(null)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<DictionaryImportSummary>()
  const [error, setError] = useState<string>()
  const [importedSources, setImportedSources] = useState<DictionarySource[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const groupId = useId().replaceAll(':', '')
  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'

  useEffect(() => {
    if (application === undefined) return
    application.listSources()
      .then((list) => setImportedSources(list))
      .catch(() => setImportedSources([]))
  }, [application, summary])

  const isFileSource = fileSources.has(selectedSource)

  const readTextFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      setText(typeof result === 'string' ? result : '')
      setTextSource('file')
    }
    reader.onerror = () => setError('ファイルの読み込みに失敗しました')
    reader.readAsText(file)
    setFileName(file.name)
  }

  const handleFileSelect = (file: File) => {
    setError(undefined)
    setSummary(undefined)
    if (isFileSource) {
      setSelectedFile(file)
      setFileName(file.name)
      setText('')
      setTextSource(null)
    } else {
      setSelectedFile(null)
      readTextFile(file)
    }
  }

  const handleImport = async () => {
    if (application === undefined) return
    if (isFileSource) {
      if (selectedFile === null) return
    } else if (text.trim().length === 0) {
      return
    }
    setLoading(true)
    setError(undefined)
    setSummary(undefined)
    try {
      const result = isFileSource
        ? await application.importFile(selectedSource, selectedFile!)
        : await application.importText(selectedSource, text)
      setSummary(result)
      if (isFileSource) {
        setSelectedFile(null)
        setFileName('')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const sourceHint = sources.find((s) => s.id === selectedSource)?.hint ?? ''
  const canImport = isFileSource
    ? selectedFile !== null
    : text.trim().length > 0

  const handleSourceChange = (sourceId: string): void => {
    setSelectedSource(sourceId)
    setText('')
    setFileName('')
    setSelectedFile(null)
    setTextSource(null)
    setError(undefined)
    setSummary(undefined)
  }

  return (
    <section aria-labelledby={`import-title-${groupId}`}>
      <h2 id={`import-title-${groupId}`} className="m-0 flex items-center gap-2 text-sm font-semibold tracking-[.02em] text-text">
        <Upload size={17} strokeWidth={1.8} aria-hidden="true" />
        Import
      </h2>
      <p className="m-0 mt-1 text-xs text-text-faint">英辞郎テキスト、Wiktionary JSONL、または Yomitan ZIP を読み込みます。</p>

      {application === undefined && (
        <p className="mt-4 text-xs text-again" role="alert">ブラウザ環境でないと辞書データの import はできません。</p>
      )}

      <fieldset className="m-0 mt-4 min-w-0 border-0 p-0" aria-label="Import ソース">
        <legend className="sr-only">Import ソース</legend>
        <div className="grid gap-2">
          {sources.map((source) => (
            <label key={source.id} className={`flex cursor-pointer items-center gap-2 rounded-[7px] border p-3 text-sm transition-[background-color,border-color] duration-120 hover:bg-surface-raised ${selectedSource === source.id ? 'border-accent bg-surface-raised' : 'border-line bg-surface'}`}>
              <input className="sr-only" type="radio" name={`import-source-${groupId}`} value={source.id} checked={selectedSource === source.id} onChange={() => handleSourceChange(source.id)} />
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selectedSource === source.id ? 'border-accent bg-accent' : 'border-text-faint'}`}>
                {selectedSource === source.id && <span className="h-1.5 w-1.5 rounded-full bg-accent-ink" />}
              </span>
              <span className="font-medium">{source.name}</span>
              <span className="ml-auto text-xs text-text-faint">{source.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          accept={isFileSource ? '.zip' : '.txt,.jsonl,.json'}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) handleFileSelect(file)
          }}
          aria-label="ファイルを選択"
        />
        <button
          className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-[7px] border px-3 text-xs font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-raised active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-45 ${(isFileSource && selectedFile !== null) || textSource === 'file' ? 'border-accent bg-surface-raised' : 'border-line bg-surface'}`}
          type="button"
          disabled={application === undefined}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileText size={15} strokeWidth={1.8} aria-hidden="true" />
          <span className="max-w-[160px] truncate">{fileName.length > 0 ? fileName : 'ファイルを選択'}</span>
          {fileName.length > 0 && <Check size={14} className="text-word-new" aria-hidden="true" />}
        </button>
        {!isFileSource && (
          <button
            className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-[7px] border px-3 text-xs font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-raised active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-45 ${textSource === 'clipboard' ? 'border-accent bg-surface-raised' : 'border-line bg-surface'}`}
            type="button"
            disabled={application === undefined || !canPaste}
            onClick={async () => {
              try {
                const pasted = await navigator.clipboard.readText()
                setText(pasted)
                setFileName('')
                setSelectedFile(null)
                setTextSource('clipboard')
              } catch {
                setError('クリップボードの読み込みに失敗しました')
              }
            }}
          >
            <ClipboardPaste size={15} strokeWidth={1.8} aria-hidden="true" />
            <span className="max-w-[160px] truncate">{textSource === 'clipboard' ? 'クリップボード貼り付け済み' : 'クリップボードから貼り付け'}</span>
            {textSource === 'clipboard' && <Check size={14} className="text-word-new" aria-hidden="true" />}
          </button>
        )}
        <button
          className="ml-auto inline-flex h-10 cursor-pointer items-center gap-2 rounded-[7px] border-0 bg-accent px-4 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
          type="button"
          disabled={application === undefined || !canImport || loading}
          onClick={() => void handleImport()}
        >
          {loading ? <Loader2 className="inline-block animate-spin" size={16} strokeWidth={2} aria-hidden="true" /> : 'Import を開始'}
        </button>
      </div>

      {!isFileSource && text.length > 0 && (
        <textarea
          className="mt-3 min-h-[80px] w-full resize-y rounded-[8px] border border-line bg-background p-3 text-sm leading-relaxed text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
          placeholder={selectedSource === 'eijiro' ? '英辞郎テキストを貼り付け' : 'JSONL 行を貼り付け'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={application === undefined}
          aria-label="Import テキスト"
        />
      )}

      {isFileSource && selectedFile !== null && (
        <p className="mt-3 text-xs text-text-faint">選択中: {selectedFile.name}</p>
      )}

      {error && <p className="mt-3 text-xs text-again" role="alert">{error}</p>}

      {summary && (
        <div className="mt-3 rounded-[8px] border border-line bg-surface p-3 text-sm">
          <p className="m-0 text-text">{summary.imported}語 import 完了</p>
          {summary.skipped > 0 && <p className="m-0 mt-1 text-xs text-text-faint">{summary.skipped}件をスキップ</p>}
          {summary.errorCount > 0 && <p className="m-0 mt-1 text-xs text-again">{summary.errorCount}件にエラー</p>}
        </div>
      )}

      {importedSources.length > 0 && (
        <div className="mt-4">
          <p className="m-0 text-xs text-text-faint">登録済みソース</p>
          <ul className="m-0 mt-1 list-none p-0">
            {importedSources.map((source) => <li className="text-sm text-text" key={source.id}>{source.name} <span className="text-xs text-text-faint">({source.format})</span></li>)}
          </ul>
        </div>
      )}
    </section>
  )
}
