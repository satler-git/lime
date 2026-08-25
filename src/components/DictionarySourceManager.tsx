import { Check, ChevronDown, ChevronUp, Loader2, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { dictionaryAdapter } from './dictionary-adapter'
import type { DictionaryImportSummary, DictionarySource } from '../dictionary/types'
import type { DictionaryManagementApplication } from '../import-service'
import type { TargetWordData } from './types'

type DictionarySourceManagerProps = {
  application?: DictionaryManagementApplication
}

const sourceHint = (format: string): string => {
  if (format === 'eijiro-text') return '英辞郎テキスト (.txt)'
  if (format === 'wiktextract-jsonl') return 'Wiktextract JSONL (.jsonl)'
  if (format === 'yomitan-zip') return 'Yomitan 辞書 (.zip)'
  return format
}

export function DictionarySourceManager({ application }: DictionarySourceManagerProps) {
  const [sources, setSources] = useState<DictionarySource[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedSource, setSelectedSource] = useState<string>('eijiro')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined)
  const [textSource, setTextSource] = useState<'file' | 'clipboard' | null>(null)
  const [summary, setSummary] = useState<DictionaryImportSummary>()
  const [error, setError] = useState<string>()
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [previewWord, setPreviewWord] = useState('')
  const [previewData, setPreviewData] = useState<TargetWordData | undefined>(undefined)
  const [previewLoading, setPreviewLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const groupId = useId().replaceAll(':', '')
  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'

  const loadSources = async () => {
    if (application === undefined) return
    try {
      const list = await application.listSources()
      setSources(list)
    } catch {
      setSources([])
    }
  }

  useEffect(() => {
    void loadSources()
  }, [application, summary])

  const handleImport = async () => {
    if (application === undefined || text.trim().length === 0) return
    setLoading(true)
    setError(undefined)
    setSummary(undefined)
    try {
      const result = await application.importText(selectedSource, text)
      setSummary(result)
      setText('')
      setTextSource(null)
      setFileName('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleFileImport = async (file: File) => {
    if (application === undefined) return
    setLoading(true)
    setError(undefined)
    setSummary(undefined)
    try {
      // Yomitan and other file parsers derive their real source id from the archive.
      // The placeholder id only selects the parser; actual metadata comes from the file.
      const result = await application.importFile(selectedSource, file)
      setSummary(result)
      setSelectedFile(undefined)
      setFileName('')
      setTextSource(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleStartImport = async () => {
    if (selectedSource === 'yomitan') {
      if (selectedFile) await handleFileImport(selectedFile)
    } else {
      await handleImport()
    }
  }

  const toggleEnabled = async (source: DictionarySource) => {
    if (application === undefined) return
    setPendingDelete(null)
    const next = { ...source, enabled: source.enabled !== false ? false : true }
    setSources(sources.map((s) => (s.id === source.id ? next : s)))
    try {
      await application.updateSource(next)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '設定の保存に失敗しました')
      await loadSources()
    }
  }

  const moveSource = async (index: number, direction: -1 | 1) => {
    if (application === undefined) return
    setPendingDelete(null)
    const next = [...sources]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    setSources(next)
    try {
      for (let i = 0; i < next.length; i += 1) {
        const source = next[i]
        await application.updateSource({ ...source, priority: i, enabled: source.enabled ?? true })
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '並び順の保存に失敗しました')
      await loadSources()
    }
  }

  const handlePreview = async () => {
    if (application === undefined || previewWord.trim().length === 0) return
    setPreviewLoading(true)
    setPreviewData(undefined)
    try {
      const entries = await application.lookup(previewWord.trim())
      setPreviewData(dictionaryAdapter(entries, previewWord.trim()))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '検索に失敗しました')
    } finally {
      setPreviewLoading(false)
    }
  }

  const startRemove = (sourceId: string) => {
    if (application === undefined || deleting !== null) return
    if (pendingDelete === sourceId) {
      void confirmRemove(sourceId)
    } else {
      setPendingDelete(sourceId)
    }
  }

  const confirmRemove = async (sourceId: string) => {
    if (application === undefined) return
    setDeleting(sourceId)
    setPendingDelete(null)
    try {
      await application.removeSource(sourceId)
      await loadSources()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="grid gap-4">
      {application === undefined && (
        <p className="text-xs text-again" role="alert">ブラウザ環境でないと辞書管理はできません。</p>
      )}

      <div>
        <p className="m-0 text-xs text-text-faint">登録済みソース</p>
        {sources.length === 0 ? (
          <p className="m-0 mt-2 text-sm text-text-muted">登録されている辞書はありません。</p>
        ) : (
          <ul className="m-0 mt-2 list-none p-0">
            {sources.map((source, index) => (
              <li key={source.id} className="flex items-center gap-2 rounded-[7px] border border-line bg-surface p-3">
                <button
                  type="button"
                  onClick={() => void toggleEnabled(source)}
                  disabled={application === undefined}
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-[background-color,border-color] duration-120 ${source.enabled !== false ? 'border-accent bg-accent text-accent-ink' : 'border-text-faint'}`}
                  aria-pressed={source.enabled !== false}
                  aria-label={`${source.name}を${source.enabled !== false ? '無効' : '有効'}化`}
                >
                  {source.enabled !== false && <Check size={14} strokeWidth={2.4} aria-hidden="true" />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm font-medium text-text">{source.name}</p>
                  <p className="m-0 text-xs text-text-faint">{sourceHint(source.format)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void moveSource(index, -1)}
                    disabled={application === undefined || index === 0}
                    className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-transparent text-text-muted transition-[background-color,transform] duration-120 hover:bg-surface-hover hover:text-text active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={`${source.name}を上に移動`}
                  >
                    <ChevronUp size={17} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveSource(index, 1)}
                    disabled={application === undefined || index === sources.length - 1}
                    className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-transparent text-text-muted transition-[background-color,transform] duration-120 hover:bg-surface-hover hover:text-text active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={`${source.name}を下に移動`}
                  >
                    <ChevronDown size={17} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void startRemove(source.id)}
                    disabled={application === undefined || deleting !== null}
                    className={`inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-[background-color,transform] duration-120 active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-45 ${
                      source.id === pendingDelete
                        ? 'border border-again bg-surface-hover text-again'
                        : 'bg-transparent text-text-muted hover:bg-surface-hover hover:text-again'
                    }`}
                    aria-pressed={source.id === pendingDelete}
                    aria-label={source.id === pendingDelete ? `${source.name}の削除を確定` : `${source.name}を削除`}
                  >
                    {source.id === deleting ? (
                      <Loader2 size={17} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                    ) : source.id === pendingDelete ? (
                      <Check size={17} strokeWidth={1.8} aria-hidden="true" />
                    ) : (
                      <Trash2 size={17} strokeWidth={1.8} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="m-0 text-xs text-text-faint">プレビュー</p>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={previewWord}
            onChange={(event) => setPreviewWord(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void handlePreview() }}
            placeholder="単語を入力"
            disabled={application === undefined}
            className="min-w-0 flex-1 rounded-[7px] border border-line bg-background px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="プレビューする単語"
          />
          <button
            type="button"
            onClick={() => void handlePreview()}
            disabled={application === undefined || previewWord.trim().length === 0 || previewLoading}
            className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[7px] border-0 bg-accent px-3 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {previewLoading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : '検索'}
          </button>
        </div>
        {previewData && (
          <div className="mt-3 rounded-[8px] border border-line bg-surface p-3">
            <p className="m-0 text-base font-medium text-text">{previewData.word}</p>
            {previewData.pronunciation && (
              <p className="m-0 text-xs text-text-muted">{previewData.pronunciation}</p>
            )}
            {previewData.partOfSpeech && (
              <p className="m-0 text-xs text-text-faint">{previewData.partOfSpeech}</p>
            )}
            <p className="m-0 mt-1 text-sm text-text">{previewData.definition}</p>
            {previewData.examples.length > 0 && (
              <ul className="m-0 mt-2 list-none space-y-1 p-0">
                {previewData.examples.map((example, index) => (
                  <li key={index} className="text-xs text-text-faint">{example}</li>
                ))}
              </ul>
            )}
            {previewData.entries?.map((entry, index) => (
              <div key={index} className="mt-3 border-t border-line pt-3">
                {entry.pronunciation && <p className="m-0 text-xs text-text-muted">{entry.pronunciation}</p>}
                {entry.partOfSpeech && <p className="m-0 text-xs text-text-faint">{entry.partOfSpeech}</p>}
                <p className="m-0 text-sm text-text">{entry.definition}</p>
                {entry.examples.length > 0 && (
                  <ul className="m-0 mt-1 list-none space-y-1 p-0">
                    {entry.examples.map((example, exampleIndex) => (
                      <li key={exampleIndex} className="text-xs text-text-faint">{example}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="m-0 text-xs text-text-faint">新規追加</p>
        <fieldset className="m-0 mt-2 min-w-0 border-0 p-0" aria-label="Import ソース">
          <legend className="sr-only">Import ソース</legend>
          <div className="grid gap-2">
            {[
              { id: 'eijiro', name: '英辞郎', hint: 'BOOTH 版テキスト (.txt)' },
              { id: 'wiktionary', name: 'Wiktionary', hint: 'kaikki.org wiktextract JSONL (.jsonl)' },
              { id: 'yomitan', name: 'Yomitan', hint: 'Yomitan 辞書 (.zip)' },
            ].map((source) => (
              <label key={source.id} className={`flex cursor-pointer items-center gap-2 rounded-[7px] border p-3 text-sm transition-[background-color,border-color] duration-120 hover:bg-surface-raised ${selectedSource === source.id ? 'border-accent bg-surface-raised' : 'border-line bg-surface'}`}>
                <input className="sr-only" type="radio" name={`import-source-${groupId}`} value={source.id} checked={selectedSource === source.id} onChange={() => setSelectedSource(source.id)} />
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selectedSource === source.id ? 'border-accent bg-accent' : 'border-text-faint'}`}>
                  {selectedSource === source.id && <span className="h-1.5 w-1.5 rounded-full bg-accent-ink" />}
                </span>
                <span className="font-medium">{source.name}</span>
                <span className="ml-auto text-xs text-text-faint">{source.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            accept=".txt,.jsonl,.json,.zip"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file === undefined || application === undefined) return
              setError(undefined)
              setSummary(undefined)
              setFileName(file.name)
              setTextSource('file')
              setSelectedFile(file)
              if (file.name.endsWith('.zip')) {
                setSelectedSource('yomitan')
                return
              }
              if (selectedSource === 'yomitan') {
                setError('Yomitan 辞書は .zip ファイルを選択してください')
                setSelectedFile(undefined)
                setFileName('')
                setTextSource(null)
                return
              }
              const reader = new FileReader()
              reader.onload = () => {
                setText(typeof reader.result === 'string' ? reader.result : '')
              }
              reader.onerror = () => setError('ファイルの読み込みに失敗しました')
              reader.readAsText(file)
            }}
            aria-label="ファイルを選択"
          />
          <button
            className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-[7px] border px-3 text-xs font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-raised active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-45 ${textSource === 'file' ? 'border-accent bg-surface-raised' : 'border-line bg-surface'}`}
            type="button"
            disabled={application === undefined}
            onClick={() => fileInputRef.current?.click()}
          >
            {textSource === 'file' ? fileName : 'ファイルを選択'}
            {textSource === 'file' && <Check size={14} className="text-word-new" aria-hidden="true" />}
          </button>
          <button
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[7px] border px-3 text-xs font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-raised active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-45 border-line bg-surface"
            type="button"
            disabled={application === undefined || !canPaste || selectedSource === 'yomitan'}
            onClick={async () => {
              try {
                const pasted = await navigator.clipboard.readText()
                setText(pasted)
                setTextSource('clipboard')
                setFileName('')
              } catch {
                setError('クリップボードの読み込みに失敗しました')
              }
            }}
          >
            {textSource === 'clipboard' ? 'クリップボード貼り付け済み' : 'クリップボードから貼り付け'}
            {textSource === 'clipboard' && <Check size={14} className="text-word-new" aria-hidden="true" />}
          </button>
          <button
            className="ml-auto inline-flex h-10 cursor-pointer items-center gap-2 rounded-[7px] border-0 bg-accent px-4 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
            type="button"
            disabled={
              application === undefined
              || loading
              || (selectedSource === 'yomitan' ? selectedFile === undefined : text.trim().length === 0)
            }
            onClick={() => void handleStartImport()}
          >
            {loading ? 'Import 中' : 'Import を開始'}
          </button>
        </div>

        {text.length > 0 && selectedSource !== 'yomitan' && (
          <textarea
            className="mt-3 min-h-[80px] w-full resize-y rounded-[8px] border border-line bg-background p-3 text-sm leading-relaxed text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
            placeholder={selectedSource === 'eijiro' ? '英辞郎テキストを貼り付け' : 'JSONL 行を貼り付け'}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={application === undefined}
            aria-label="Import テキスト"
          />
        )}

        {error && <p className="mt-3 text-xs text-again" role="alert">{error}</p>}
        {summary && (
          <div className="mt-3 rounded-[8px] border border-line bg-surface p-3 text-sm">
            <p className="m-0 text-text">{summary.imported}語 import 完了</p>
            {summary.skipped > 0 && <p className="m-0 mt-1 text-xs text-text-faint">{summary.skipped}件をスキップ</p>}
            {summary.errorCount > 0 && <p className="m-0 mt-1 text-xs text-again">{summary.errorCount}件にエラー</p>}
          </div>
        )}
      </div>
    </div>
  )
}
