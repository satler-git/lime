import { Plus } from 'lucide-react'

type AddCardButtonProps = {
  onClick?: () => void
  disabled?: boolean
}

export function AddCardButton({ onClick, disabled = false }: AddCardButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-[8px] border border-line bg-surface px-4 text-sm font-semibold text-text transition-[background-color,transform] duration-120 hover:bg-surface-raised active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Plus size={17} strokeWidth={2} aria-hidden="true" />
      カードを追加・管理
    </button>
  )
}
