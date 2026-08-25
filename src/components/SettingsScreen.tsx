import { User, Sparkles, SlidersHorizontal, BookOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DictionaryImportApplication } from '../import-service'
import type { LlmConfig } from '../settings-storage'
import { ImportSection } from './ImportSection'

type SettingsScreenProps = {
  reviewLimit?: number
  newLimit?: number
  onReviewLimitChange?: (limit: number) => void
  onNewLimitChange?: (limit: number) => void
  llmConfig?: LlmConfig
  onLlmConfigChange?: (config: LlmConfig) => void
  importApplication?: DictionaryImportApplication
}

const clamp = (value: number) => Math.max(0, Number.isNaN(value) ? 0 : value)

function SettingGroup({
  icon: Icon,
  title,
  children,
  id,
}: {
  icon: typeof User
  title: string
  children: React.ReactNode
  id: string
}) {
  return (
    <section className="rounded-[10px] border border-line bg-surface p-5" aria-labelledby={id}>
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
        <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
        <h2 id={id} className="m-0 text-xs font-semibold tracking-[.08em] text-text-muted">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function NumberInput({
  label,
  value,
  onChange,
  suffix = '',
  min = 0,
  disabled = false,
}: {
  label: string
  value: number
  onChange: (next: number) => void
  suffix?: string
  min?: number
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <input
          className="w-20 rounded-[7px] border border-line bg-background px-3 py-2 text-right text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
          type="number"
          min={min}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(clamp(parseInt(event.target.value, 10)))}
          aria-label={label}
        />
        {suffix && <span className="text-xs text-text-faint">{suffix}</span>}
      </div>
    </div>
  )
}

function TextInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder = '',
  disabled = false,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  type?: 'text' | 'password'
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs text-text-muted">{label}</label>
      <input
        className="rounded-[7px] border border-line bg-background px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

export function SettingsScreen({
  reviewLimit = 50,
  newLimit = 20,
  onReviewLimitChange,
  onNewLimitChange,
  llmConfig = { endpoint: '', model: '', apiKey: '' },
  onLlmConfigChange,
  importApplication,
}: SettingsScreenProps) {
  const [localLlm, setLocalLlm] = useState(llmConfig)

  useEffect(() => {
    setLocalLlm(llmConfig)
  }, [llmConfig])

  return (
    <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8 sm:py-12" aria-labelledby="settings-title">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
        <SlidersHorizontal size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>設定</span>
      </div>
      <h1 id="settings-title" className="m-0 mt-2 font-serif text-[clamp(32px,7vw,48px)] font-normal leading-tight tracking-[-.04em]">
        Settings
      </h1>

      <div className="mt-7 grid gap-4">
        <SettingGroup id="import-section" icon={BookOpen} title="Import">
          <ImportSection application={importApplication} />
        </SettingGroup>

        <SettingGroup id="max-section" icon={SlidersHorizontal} title="Max">
          <div className="grid gap-4">
            <NumberInput
              label="復習上限"
              value={reviewLimit}
              onChange={(next) => onReviewLimitChange?.(next)}
              suffix="語/日"
            />
            <NumberInput
              label="新出上限"
              value={newLimit}
              onChange={(next) => onNewLimitChange?.(next)}
              suffix="語/日"
            />
          </div>
        </SettingGroup>

        <SettingGroup id="llm-section" icon={Sparkles} title="LLM">
          <div className="grid gap-4">
            <TextInput
              label="API Endpoint"
              value={localLlm.endpoint}
              placeholder="https://api.openai.com/v1/chat/completions"
              onChange={(endpoint) => {
                setLocalLlm((current) => ({ ...current, endpoint }))
                onLlmConfigChange?.({ ...localLlm, endpoint })
              }}
            />
            <TextInput
              label="Model"
              value={localLlm.model}
              placeholder="gpt-4o-mini"
              onChange={(model) => {
                setLocalLlm((current) => ({ ...current, model }))
                onLlmConfigChange?.({ ...localLlm, model })
              }}
            />
            <TextInput
              label="API Key"
              value={localLlm.apiKey}
              type="password"
              placeholder="sk-..."
              onChange={(apiKey) => {
                setLocalLlm((current) => ({ ...current, apiKey }))
                onLlmConfigChange?.({ ...localLlm, apiKey })
              }}
            />
          </div>
        </SettingGroup>

        <SettingGroup id="account-section" icon={User} title="Account">
          <p className="m-0 text-xs text-text-faint">アカウント設定は UI Unit 3.5 以降で実装予定です。</p>
        </SettingGroup>
      </div>
    </main>
  )
}
