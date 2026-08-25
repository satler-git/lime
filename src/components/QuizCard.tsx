import { Check, ChevronRight, CircleHelp } from 'lucide-react'

type QuizOption = { id: string; text: string }

type QuizCardProps = {
  question: string
  questionNumber?: number
  totalQuestions?: number
  options: QuizOption[]
  selectedId?: string
  correctId?: string
  onSelect?: (id: string) => void
  onNext?: () => void
  pending?: boolean
}

export function QuizCard({ question, questionNumber = 1, totalQuestions = 5, options, selectedId, correctId, onSelect, onNext, pending = false }: QuizCardProps) {
  const answered = Boolean(selectedId)
  const resultMessage = answered
    ? selectedId === correctId ? '正解です' : '不正解です'
    : ''

  return (
    <section className="max-w-[620px] rounded-[10px] border border-line bg-surface p-5" aria-labelledby="quiz-question" aria-busy={pending}>
      <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-[11px] font-semibold tracking-[.08em] text-accent"><CircleHelp size={16} strokeWidth={1.8} aria-hidden="true" /> 読解チェック</div><span className="text-xs tabular-nums text-text-faint">{questionNumber} / {totalQuestions}問</span></div>
      <h2 id="quiz-question" className="m-0 mb-5 max-w-[590px] font-serif text-[28px] font-normal leading-tight tracking-[-.03em]">{question}</h2>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{pending ? '回答を保存しています' : resultMessage}</p>
      <fieldset className="m-0 min-w-0 border-0 p-0" aria-label="回答の選択肢">
        <legend className="sr-only">回答の選択肢</legend>
        <div className="grid gap-3">
          {options.map((option, index) => {
            const isSelected = selectedId === option.id
            const isCorrect = correctId === option.id && answered
            return (
              <label className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[7px] border border-transparent bg-surface-raised p-3 text-left text-[13px] transition-[background-color,border-color,transform] duration-120 hover:bg-surface-hover has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent active:scale-[.99] ${isSelected ? 'border-[rgba(194,230,111,.45)] bg-[rgba(194,230,111,.11)]' : ''} ${isCorrect ? 'border-accent bg-[rgba(194,230,111,.2)]' : ''}`} key={option.id}>
                <input className="sr-only" type="radio" name={`quiz-question-${questionNumber}`} value={option.id} checked={isSelected} onChange={() => onSelect?.(option.id)} disabled={pending} />
                <span className={`flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-[5px] border text-[11px] ${isSelected ? 'border-accent bg-accent text-accent-ink' : 'border-line text-text-muted'}`}>{String.fromCharCode(65 + index)}</span>
                <span>{option.text}</span>
                {isCorrect && <Check className="ml-auto text-accent" size={17} strokeWidth={2.2} aria-label="正解" />}
              </label>
            )
          })}
        </div>
      </fieldset>
      <button className="mt-5 inline-flex min-h-[42px] cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-line bg-surface-raised px-4 text-xs font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.96] disabled:cursor-wait disabled:opacity-60" type="button" disabled={!answered || pending} aria-busy={pending} onClick={onNext}><span>{pending ? '保存しています' : questionNumber === totalQuestions ? '確認を終える' : '次の問題'}</span><ChevronRight size={17} strokeWidth={2} aria-hidden="true" /></button>
    </section>
  )
}
