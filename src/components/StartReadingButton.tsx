import { ArrowRight } from 'lucide-react'

type StartReadingButtonProps = {
  onClick?: () => void
  disabled?: boolean
}

export function StartReadingButton({ onClick, disabled = false }: StartReadingButtonProps) {
  return (
    <button className="inline-flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[8px] border-0 bg-accent px-4 text-sm font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98]" type="button" disabled={disabled} onClick={onClick}>
      読解を始める
      <ArrowRight size={17} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}
