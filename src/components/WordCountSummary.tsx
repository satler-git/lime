import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type WordCountSummaryProps = {
  reviewCount?: number
  newCount?: number
  reviewLimit?: number
  newLimit?: number
  disabled?: boolean
  onReviewLimitChange?: (limit: number) => void
  onNewLimitChange?: (limit: number) => void
}

type Category = 'review' | 'new'

type AdjustModalProps = {
  open: boolean
  title: string
  available: number
  value: number
  disabled?: boolean
  onChange: (next: number) => void
  onClose: () => void
}

const clamp = (value: number, min: number) => Math.max(min, Number.isNaN(value) ? 0 : value)

function LimitAdjustModal({ open, title, available, value, disabled, onChange, onClose }: AdjustModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      setDraft(value)
      dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open, value])

  return (
    <dialog
      ref={dialogRef}
      className="relative z-50 w-[min(320px,calc(100vw-32px))] rounded-[12px] border border-line bg-surface-raised p-5 text-text shadow-[0_18px_48px_rgba(0,0,0,.45)] [&::backdrop]:bg-black/60"
      onCancel={onClose}
      onClick={(event) => event.target === dialogRef.current && onClose()}
      aria-label={title}
    >
      <h2 className="m-0 text-sm font-semibold tracking-[.02em]">{title}</h2>
      <p className="m-0 mt-1 text-xs text-text-faint">利用可能: {available}語</p>
      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs text-text-faint">上限</span>
        <input
          className="w-20 rounded-[7px] border border-line bg-background px-3 py-2 text-right text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          type="number"
          min={0}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(clamp(parseInt(event.target.value, 10), 0))}
          aria-label="上限を設定"
        />
        <span className="text-xs text-text-faint">語</span>
        <button
          className="ml-auto inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] border border-line bg-surface px-3 text-xs font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          disabled={disabled}
          onClick={() => setDraft((current) => current + 20)}
        >
          <Plus size={14} strokeWidth={2} aria-hidden="true" />
          20
        </button>
      </div>
      <button
        className="mt-5 h-10 w-full cursor-pointer rounded-[7px] border-0 bg-accent text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        disabled={disabled}
        onClick={() => { onChange(draft); onClose() }}
      >
        完了
      </button>
    </dialog>
  )
}

export function WordCountSummary({
  reviewCount = 72,
  newCount = 28,
  reviewLimit,
  newLimit,
  disabled,
  onReviewLimitChange,
  onNewLimitChange,
}: WordCountSummaryProps) {
  const defaultReviewMax = Math.min(reviewCount, 50)
  const defaultNewMax = Math.min(newCount, 20)
  const [internalReviewMax, setInternalReviewMax] = useState(clamp(reviewLimit ?? defaultReviewMax, 0))
  const [internalNewMax, setInternalNewMax] = useState(clamp(newLimit ?? defaultNewMax, 0))
  const [openCategory, setOpenCategory] = useState<Category | null>(null)

  const isReviewControlled = onReviewLimitChange !== undefined
  const isNewControlled = onNewLimitChange !== undefined
  const reviewMax = isReviewControlled ? clamp(reviewLimit ?? defaultReviewMax, 0) : internalReviewMax
  const newMax = isNewControlled ? clamp(newLimit ?? defaultNewMax, 0) : internalNewMax

  const changeReviewMax = (next: number) => {
    if (isReviewControlled) onReviewLimitChange?.(next)
    else setInternalReviewMax(next)
  }
  const changeNewMax = (next: number) => {
    if (isNewControlled) onNewLimitChange?.(next)
    else setInternalNewMax(next)
  }

  const studyCount = (count: number, max: number) => Math.min(count, max)

  const Card = ({
    label,
    count,
    max,
    category,
  }: {
    label: string
    count: number
    max: number
    category: Category
  }) => (
    <div className="rounded-[10px] border border-line bg-surface p-4">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-1">
          <span className="text-[30px] font-semibold leading-9 text-text">{studyCount(count, max)}</span>
          <span className="text-sm text-text-faint">語</span>
        </div>
        <button
          className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border border-line bg-surface-raised text-text-muted transition-[background-color,transform] duration-120 hover:bg-surface-hover hover:text-text active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          disabled={disabled}
          aria-label={`${label}を増やす`}
          onClick={() => setOpenCategory(category)}
        >
          <Plus size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  )

  return (
    <section aria-labelledby="word-count-title">
      <h2 id="word-count-title" className="m-0 text-xs font-semibold tracking-[.08em] text-text-muted">今日の単語</h2>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Card label="復習" count={reviewCount} max={reviewMax} category="review" />
        <Card label="新出" count={newCount} max={newMax} category="new" />
      </div>
      <LimitAdjustModal
        open={openCategory === 'review'}
        title="復習の上限"
        available={reviewCount}
        value={reviewMax}
        disabled={disabled}
        onChange={changeReviewMax}
        onClose={() => setOpenCategory(null)}
      />
      <LimitAdjustModal
        open={openCategory === 'new'}
        title="新出の上限"
        available={newCount}
        value={newMax}
        disabled={disabled}
        onChange={changeNewMax}
        onClose={() => setOpenCategory(null)}
      />
    </section>
  )
}
