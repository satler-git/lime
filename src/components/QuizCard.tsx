import { Check, ChevronRight, CircleHelp } from 'lucide-react'

type QuizOption = { id: string; text: string }

type QuizCardProps = {
  question: string
  questionNumber?: number
  totalQuestions?: number
  relatedWord: string
  options: QuizOption[]
  selectedId?: string
  correctId?: string
  onSelect?: (id: string) => void
  onNext?: () => void
}

export function QuizCard({ question, questionNumber = 1, totalQuestions = 5, relatedWord, options, selectedId, correctId, onSelect, onNext }: QuizCardProps) {
  const answered = Boolean(selectedId)

  return (
    <section className="max-w-[620px] rounded-[10px] border border-line bg-surface p-5" aria-labelledby="quiz-question">
      <div className="flex items-center justify-between"><div className="flex items-center gap-[7px] text-[11px] font-semibold tracking-[.08em] text-accent"><CircleHelp size={16} strokeWidth={1.8} aria-hidden="true" /> 読解チェック</div><span className="text-xs tabular-nums text-text-faint">{questionNumber} / {totalQuestions}問</span></div>
      <p className="mb-[9px] mt-6 text-xs text-text-muted">「{relatedWord}」に関する問題</p>
      <h2 id="quiz-question" className="m-0 mb-[19px] max-w-[590px] font-serif text-[28px] font-normal leading-tight tracking-[-.03em]">{question}</h2>
      <div className="grid gap-1.5" role="radiogroup" aria-label="回答の選択肢">
        {options.map((option, index) => {
          const isSelected = selectedId === option.id
          const isCorrect = correctId === option.id && answered
          return <button className={`flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-[7px] border border-transparent bg-surface-raised p-[7px_10px] text-left text-[13px] transition-[background-color,border-color,transform] duration-120 hover:bg-surface-hover active:scale-[.99] ${isSelected ? 'border-[rgba(194,230,111,.45)] bg-[rgba(194,230,111,.11)]' : ''} ${isCorrect ? 'border-accent bg-[rgba(194,230,111,.2)]' : ''}`} key={option.id} type="button" role="radio" aria-checked={isSelected} onClick={() => onSelect?.(option.id)}><span className={`flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-[5px] border text-[11px] ${isSelected ? 'border-accent bg-accent text-accent-ink' : 'border-line text-text-muted'}`}>{String.fromCharCode(65 + index)}</span><span>{option.text}</span>{isCorrect && <Check className="ml-auto text-accent" size={17} strokeWidth={2.2} aria-label="正解" />}</button>
        })}
      </div>
      <button className="mt-[17px] inline-flex min-h-[42px] cursor-pointer items-center justify-center gap-[7px] rounded-[7px] border border-line bg-surface-raised px-[13px] text-xs font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.96]" type="button" disabled={!answered} onClick={onNext}><span>{questionNumber === totalQuestions ? '確認を終える' : '次の問題'}</span><ChevronRight size={17} strokeWidth={2} aria-hidden="true" /></button>
    </section>
  )
}
