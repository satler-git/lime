import { Check, Clock3, Flame, Gauge, type LucideIcon } from 'lucide-react'
import type { Rating } from '../domain/card'

type RatingGroupProps = {
  value?: Rating
  onChange?: (rating: Rating) => void
  compact?: boolean
  disabled?: boolean
}

type RatingOption = {
  value: Rating
  label: string
  hint: string
  icon: LucideIcon
}

const options: RatingOption[] = [
  { value: 'again', label: 'もう一度', hint: '1分', icon: Flame },
  { value: 'hard', label: '難しい', hint: '6分', icon: Clock3 },
  { value: 'good', label: 'できた', hint: '3日', icon: Check },
  { value: 'easy', label: '簡単', hint: '9日', icon: Gauge },
]

const colorClasses: Record<Rating, string> = {
  again: 'text-again',
  hard: 'text-hard',
  good: 'text-good',
  easy: 'text-easy',
}

export function RatingGroup({ value, onChange, compact = false, disabled = false }: RatingGroupProps) {
  const iconSize = compact ? 15 : 16
  return (
    <div className="mt-[9px] grid grid-cols-4 gap-[5px]" role="group" aria-label="単語の理解度を評価">
      {options.map(({ value: optionValue, label, hint, icon: Icon }) => (
        <button className={`flex min-h-[60px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[7px] border border-transparent bg-surface p-[7px_3px] ${colorClasses[optionValue]} transition-[background-color,border-color,transform] duration-120 hover:bg-surface-hover active:scale-[.96] disabled:cursor-wait disabled:opacity-60 ${value === optionValue ? 'border-current bg-current text-surface-raised' : ''}`} key={optionValue} type="button" aria-pressed={value === optionValue} onClick={() => onChange?.(optionValue)} disabled={disabled}>
          <Icon size={iconSize} strokeWidth={1.8} aria-hidden="true" />
          <span className={`text-[11px] font-medium ${value === optionValue ? 'text-surface-raised' : 'text-text'}`}>{label}</span>
          <span className={`text-[10px] ${value === optionValue ? 'text-surface-raised' : 'text-text-faint'}`}>{hint}</span>
        </button>
      ))}
    </div>
  )
}
