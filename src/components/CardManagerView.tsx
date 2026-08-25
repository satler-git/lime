import { Plus, Search, Trash2, Upload, BookOpen, ChevronLeft, List, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Card } from '../domain/card'
import type { DictionaryManagementApplication } from '../import-service'
import type { CardService } from '../application/card-service'
import { dictionaryAdapter } from './dictionary-adapter'
import type { TargetWordData } from './types'
import { parseCardCsv, parseApkg } from '../card-import'

type CardManagerViewProps = {
  cardService: CardService | undefined
  dictionaryApplication?: DictionaryManagementApplication
  onBack?: () => void
  onCardsChanged?: () => void
}

type ImportFormat = 'csv' | 'apkg'

const formatLabels: Record<ImportFormat, string> = { csv: 'CSV / テキスト', apkg: 'APKG (Anki)' }

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[10px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
        <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
        <h2 className="m-0 text-xs font-semibold tracking-[.08em] text-text-muted">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function AddSection({
  cardService,
  dictionaryApplication,
  onAdded,
}: {
  cardService: CardService
  dictionaryApplication?: DictionaryManagementApplication
  onAdded: () => void
}) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<TargetWordData | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string>()
  const [alreadyInSrs, setAlreadyInSrs] = useState(false)
  const [added, setAdded] = useState(false)

  const handleSearch = async () => {
    const word = query.trim()
    if (word.length === 0 || dictionaryApplication === undefined) return
    setLoading(true)
    setError(undefined)
    setResult(undefined)
    setAlreadyInSrs(false)
    setAdded(false)
    try {
      const entries = await dictionaryApplication.lookup(word)
      const adapted = dictionaryAdapter(entries, word)
      setResult(adapted)
      const existing = await cardService.findByWord(word)
      setAlreadyInSrs(existing !== null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '検索に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = async () => {
    const word = query.trim()
    if (word.length === 0 || alreadyInSrs) return
    setAdding(true)
    setError(undefined)
    try {
      await cardService.createIfAbsent({ word })
      setAdded(true)
      onAdded()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '追加に失敗しました')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void handleSearch() }}
          placeholder="単語を入力"
          disabled={dictionaryApplication === undefined}
          className="min-w-0 flex-1 rounded-[7px] border border-line bg-background px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
          aria-label="追加する単語"
        />
        <button
          type="button"
          onClick={() => void handleSearch()}
          disabled={dictionaryApplication === undefined || query.trim().length === 0 || loading}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[7px] border-0 bg-accent px-3 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-ink border-t-transparent" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
          検索
        </button>
      </div>

      {dictionaryApplication === undefined && (
        <p className="text-xs text-again" role="alert">ブラウザ環境でないと単語検索はできません。</p>
      )}

      {result === undefined && !loading && query.trim().length > 0 && !error && (
        <p className="text-sm text-text-muted">辞書に見つかりませんでした。</p>
      )}

      {result !== undefined && (
        <div className="rounded-[8px] border border-line bg-surface p-4">
          <p className="m-0 font-serif text-[22px] font-medium tracking-[-.03em]">{result.word}</p>
          {(result.pronunciation || result.partOfSpeech) && (
            <div className="mt-1 flex flex-wrap items-baseline gap-2 text-xs text-text-faint">
              {result.pronunciation && <span>{result.pronunciation}</span>}
              {result.partOfSpeech && <span>{result.partOfSpeech}</span>}
            </div>
          )}
          <p className="m-0 mt-2 text-sm leading-normal text-text">{result.definition}</p>
          {result.examples.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="m-0 flex items-center gap-1.5 text-[10px] font-semibold tracking-[.1em] text-text-faint"><BookOpen size={12} strokeWidth={1.8} aria-hidden="true" /> 例文</p>
              {result.examples.slice(0, 3).map((example, index) => (
                <p key={index} className="m-0 mt-2 text-xs leading-normal text-text-muted">{example}</p>
              ))}
            </div>
          )}
          {alreadyInSrs ? (
            <p className="mt-3 text-xs text-text-muted">この単語はすでに SRS に追加されています。</p>
          ) : (
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={adding || added}
              className="mt-4 flex min-h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border-0 bg-accent px-3 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Plus size={15} strokeWidth={2} aria-hidden="true" />
              {added ? '追加しました' : adding ? '追加中…' : 'SRS に追加'}
            </button>
          )}
        </div>
      )}

      {error && <p className="text-xs text-again" role="alert">{error}</p>}
    </div>
  )
}

function ImportSection({ cardService, onImported }: { cardService: CardService; onImported: () => void }) {
  const [format, setFormat] = useState<ImportFormat>('csv')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [summary, setSummary] = useState<{ added: number; skipped: number } | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (selected: File | undefined) => {
    setFile(selected)
    setText('')
    setSummary(undefined)
    setError(undefined)
    if (selected?.name.endsWith('.apkg')) {
      setFormat('apkg')
    } else if (selected?.name.endsWith('.csv') || selected?.name.endsWith('.txt')) {
      setFormat('csv')
    }
  }

  const handleImport = async () => {
    setLoading(true)
    setError(undefined)
    setSummary(undefined)
    try {
      let words: string[] = []
      if (format === 'apkg') {
        if (file === undefined) throw new Error('.apkg ファイルを選択してください')
        words = await parseApkg(file)
      } else {
        const source = file !== undefined ? await file.text() : text
        if (source.trim().length === 0) throw new Error('CSV またはテキストを入力してください')
        words = parseCardCsv(source)
      }

      let added = 0
      let skipped = 0
      for (const word of words) {
        try {
          const existing = await cardService.findByWord(word)
          if (existing !== null) {
            skipped += 1
            continue
          }
          await cardService.createIfAbsent({ word })
          added += 1
        } catch {
          skipped += 1
        }
      }

      setSummary({ added, skipped })
      if (added > 0) onImported()
      if (format === 'csv') setText('')
      setFile(undefined)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid gap-4">
      <fieldset className="m-0 border-0 p-0" aria-label="Import 形式">
        <legend className="sr-only">Import 形式</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['csv', 'apkg'] as ImportFormat[]).map((f) => (
            <label key={f} className={`flex cursor-pointer items-center gap-2 rounded-[7px] border p-3 text-sm transition-[background-color,border-color] duration-120 hover:bg-surface-raised ${format === f ? 'border-accent bg-surface-raised' : 'border-line bg-surface'}`}>
              <input className="sr-only" type="radio" name="import-format" value={f} checked={format === f} onChange={() => setFormat(f)} />
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${format === f ? 'border-accent bg-accent' : 'border-text-faint'}`}>
                {format === f && <span className="h-1.5 w-1.5 rounded-full bg-accent-ink" />}
              </span>
              {formatLabels[f]}
            </label>
          ))}
        </div>
      </fieldset>

      {format === 'csv' && (
        <textarea
          className="min-h-[120px] w-full resize-y rounded-[8px] border border-line bg-background p-3 text-sm leading-relaxed text-text focus:border-accent focus:outline-none"
          placeholder={`1 行に 1 単語、または CSV の 1 列目を単語として扱います\n例:\nresilient\nresilient,しなやかな`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="Import する単語"
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileInputRef} type="file" className="sr-only" accept={format === 'apkg' ? '.apkg' : '.csv,.txt'} onChange={(event) => handleFileChange(event.target.files?.[0])} aria-label="ファイルを選択" />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[7px] border border-line bg-surface px-3 text-xs font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-raised active:scale-[.96]"
        >
          <Upload size={14} aria-hidden="true" />
          {file !== undefined ? file.name : 'ファイルを選択'}
        </button>
        <button
          type="button"
          onClick={() => void handleImport()}
          disabled={loading || (format === 'apkg' ? file === undefined : text.trim().length === 0 && file === undefined)}
          className="ml-auto inline-flex h-10 cursor-pointer items-center gap-2 rounded-[7px] border-0 bg-accent px-4 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent-ink border-t-transparent" aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
          {loading ? 'Import 中…' : 'Import'}
        </button>
      </div>

      {error && <p className="text-xs text-again" role="alert">{error}</p>}
      {summary && (
        <div className="rounded-[8px] border border-line bg-surface p-3 text-sm">
          <p className="m-0 text-text">{summary.added} 語を追加しました</p>
          {summary.skipped > 0 && <p className="m-0 mt-1 text-xs text-text-faint">{summary.skipped} 語をスキップ（既に存在または読み取れません）</p>}
        </div>
      )}
    </div>
  )
}

const ROW_HEIGHT = 44
const VISIBLE_BUFFER = 6

function ListSection({
  cardService,
  onChanged,
  refreshToken,
}: {
  cardService: CardService
  onChanged: () => void
  refreshToken: number
}) {
  const [cards, setCards] = useState<Card[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const containerHeight = 360

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const all = await cardService.loadAll()
      setCards(all.sort((a, b) => a.word.localeCompare(b.word)))
    } catch (err: unknown) {
      setCards([])
    } finally {
      setLoading(false)
    }
  }, [cardService])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const filtered = useMemo(() => {
    const trimmed = filter.trim().toLowerCase()
    if (trimmed.length === 0) return cards
    return cards.filter((card) => card.word.toLowerCase().includes(trimmed))
  }, [cards, filter])

  const totalHeight = filtered.length * ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_BUFFER)
  const endIndex = Math.min(filtered.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + VISIBLE_BUFFER)
  const visibleCards = filtered.slice(startIndex, endIndex)

  const handleDelete = async (card: Card) => {
    setDeleting(card.id)
    try {
      await cardService.delete(card.id)
      onChanged()
      await load()
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <input
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="単語を絞り込む"
          className="min-w-0 flex-1 rounded-[7px] border border-line bg-background px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
          aria-label="単語を絞り込む"
        />
        <span className="shrink-0 text-xs text-text-faint">{filtered.length} 語</span>
      </div>

      <div
        ref={listRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="relative overflow-y-auto rounded-[8px] border border-line bg-surface"
        style={{ height: containerHeight }}
      >
        {loading && cards.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">読み込み中…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">カードがありません。</p>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            {visibleCards.map((card, index) => {
              const actualIndex = startIndex + index
              return (
                <div
                  key={card.id}
                  className="absolute inset-x-0 flex items-center justify-between gap-3 border-b border-line px-3 py-2.5 last:border-b-0"
                  style={{ top: actualIndex * ROW_HEIGHT, height: ROW_HEIGHT }}
                >
                  <span className="min-w-0 truncate text-sm text-text" title={card.word}>{card.word}</span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(card)}
                    disabled={deleting === card.id}
                    className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent text-text-muted transition-[background-color,transform] duration-120 hover:bg-surface-hover hover:text-again active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={`${card.word} を削除`}
                  >
                    {deleting === card.id ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function CardManagerView({ cardService, dictionaryApplication, onBack, onCardsChanged }: CardManagerViewProps) {
  const titleId = useId().replaceAll(':', '')
  const [refreshToken, setRefreshToken] = useState(0)

  const handleChanged = () => {
    setRefreshToken((token) => token + 1)
    onCardsChanged?.()
  }

  return (
    <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8 sm:py-12" aria-labelledby={titleId}>
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
            <List size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>カード管理</span>
          </div>
          <h1 id={titleId} className="m-0 mt-2 font-serif text-[clamp(32px,7vw,48px)] font-normal leading-tight tracking-[-.04em]">
            カードを追加・管理
          </h1>
        </div>
        {onBack !== undefined && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent text-text-muted transition-[background-color,transform] duration-120 hover:bg-surface-hover hover:text-text active:scale-[.96]"
            aria-label="戻る"
          >
            <ChevronLeft size={19} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </header>

      {cardService === undefined ? (
        <p className="mt-8 text-sm text-text-muted">カードサービスを読み込んでいます…</p>
      ) : (
        <div className="mt-7 grid gap-5">
          <Section icon={Search} title="単語を追加">
            <AddSection cardService={cardService} dictionaryApplication={dictionaryApplication} onAdded={handleChanged} />
          </Section>

          <Section icon={Upload} title="Import">
            <ImportSection cardService={cardService} onImported={handleChanged} />
          </Section>

          <Section icon={BookOpen} title="単語一覧">
            <ListSection cardService={cardService} onChanged={handleChanged} refreshToken={refreshToken} />
          </Section>
        </div>
      )}
    </main>
  )
}
