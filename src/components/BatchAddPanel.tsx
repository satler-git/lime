import { Check, Plus } from 'lucide-react'

type Candidate = { word: string; context: string }

type BatchAddPanelProps = {
  candidates: Candidate[]
  selected?: string[]
  onToggle?: (word: string) => void
  onAdd?: () => void | Promise<void>
  disabled?: boolean
  loading?: boolean
}

export function BatchAddPanel({ candidates, selected = [], onToggle, onAdd, disabled = false, loading = false }: BatchAddPanelProps) {
  return (
    <section className="max-w-[620px] rounded-[10px] border border-line bg-surface p-5" aria-labelledby="batch-title">
      <p className="m-0 text-[10px] font-semibold tracking-[.1em] text-text-faint">読了後にまとめて追加</p>
      <h2 id="batch-title" className="m-0 mt-4 font-serif text-[28px] font-normal leading-tight tracking-[-.035em]">調べた単語</h2>
      <p className="mt-4 mb-5 text-[13px] leading-normal text-text-muted">読中に調べた、まだ SRS にない単語です。追加する単語を選んでください。</p>
      <div className="flex flex-col gap-3">
        {candidates.map((candidate) => {
          const isSelected = selected.includes(candidate.word)
          return (
            <button className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[7px] border border-transparent bg-surface-raised p-3 text-left transition-[background-color,border-color] duration-120 hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60 ${isSelected ? 'border-[rgba(194,230,111,.4)] bg-[rgba(194,230,111,.11)]' : ''}`} key={candidate.word} type="button" aria-pressed={isSelected} onClick={() => onToggle?.(candidate.word)} disabled={disabled || loading}>
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${isSelected ? 'border-accent bg-accent text-accent-ink' : 'border-text-faint'}`}>{isSelected && <Check size={14} strokeWidth={2.4} aria-hidden="true" />}</span>
              <span className="flex min-w-0 flex-col gap-1.5"><strong className="font-serif text-[17px] font-medium">{candidate.word}</strong><small className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-text-faint">{candidate.context}</small></span>
            </button>
          )
        })}
      </div>
      <button className="mt-5 flex min-h-[42px] w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border-0 bg-accent px-4 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.96] disabled:cursor-wait disabled:opacity-60" type="button" aria-busy={loading} disabled={!selected.length || disabled || loading} onClick={onAdd}><Plus size={17} strokeWidth={2.2} aria-hidden="true" /> {loading ? '追加しています' : `選択した ${selected.length} 語を SRS に追加`}</button>
      <p className="sr-only" role="status" aria-live="polite">{loading ? '単語を追加しています' : disabled ? '単語を SRS に追加しました' : ''}</p>
    </section>
  )
}
