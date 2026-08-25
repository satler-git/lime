import { User, Sparkles, SlidersHorizontal, BookOpen, ChevronLeft } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth'
import type { DictionaryManagementApplication } from '../import-service'
import type { LlmConfig } from '../settings-storage'
import { DictionarySourceManager } from './DictionarySourceManager'

type SettingsScreenProps = {
  reviewLimit?: number
  newLimit?: number
  onReviewLimitChange?: (limit: number) => void
  onNewLimitChange?: (limit: number) => void
  llmConfig?: LlmConfig
  onLlmConfigChange?: (config: LlmConfig) => void
  importApplication?: DictionaryManagementApplication
  onBack?: () => void
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
  autoComplete,
  name,
  masked,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  type?: 'text' | 'password'
  placeholder?: string
  disabled?: boolean
  autoComplete?: string
  name?: string
  masked?: boolean
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs text-text-muted">{label}</label>
      <input
        className={`rounded-[7px] border border-line bg-background px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${masked ? '[-webkit-text-security:disc]' : ''}`}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        name={name}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

const isSafePictureUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function AccountSection() {
  const { user, isLoading, error, login, logout } = useAuth()
  const [pictureError, setPictureError] = useState(false)

  useEffect(() => {
    setPictureError(false)
  }, [user?.id])

  if (isLoading) {
    return <p className="m-0 text-sm text-text-faint">アカウント情報を読み込み中…</p>
  }

  if (user !== null) {
    const pictureUrl = user.picture && isSafePictureUrl(user.picture) ? user.picture : null
    const showPicture = pictureUrl !== null && !pictureError

    return (
      <div className="grid gap-2">
        <div className="flex items-center gap-3">
          {showPicture ? (
            <img
              src={pictureUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="h-10 w-10 rounded-full object-cover"
              onError={() => setPictureError(true)}
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-raised">
              <User size={20} strokeWidth={1.8} className="text-text-faint" aria-hidden="true" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-sm font-medium text-text">{user.name || user.email}</p>
            {user.name && <p className="m-0 truncate text-xs text-text-faint">{user.email}</p>}
          </div>
          <button
            type="button"
            onClick={() => { void logout() }}
            disabled={isLoading}
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[7px] border-0 bg-again px-4 text-xs font-semibold text-background transition-[background-color,transform] duration-120 hover:opacity-90 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
          >
            Logout
          </button>
        </div>
        {error && <p className="m-0 text-xs text-again" role="alert">{error.message}</p>}
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={() => { void login() }}
        disabled={isLoading}
        className="inline-flex h-10 w-fit cursor-pointer items-center gap-2 rounded-[7px] border-0 bg-accent px-4 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45"
      >
        Login with Google
      </button>
      {error && <p className="m-0 text-xs text-again" role="alert">{error.message}</p>}
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
  onBack,
}: SettingsScreenProps) {
  const [localLlm, setLocalLlm] = useState(llmConfig)
  const localLlmRef = useRef(localLlm)

  useEffect(() => {
    setLocalLlm(llmConfig)
    localLlmRef.current = llmConfig
  }, [llmConfig])

  const updateLlm = useCallback((patch: Partial<typeof localLlm>) => {
    const next = { ...localLlmRef.current, ...patch }
    localLlmRef.current = next
    setLocalLlm(next)
    onLlmConfigChange?.(next)
  }, [onLlmConfigChange])

  return (
    <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8 sm:py-12" aria-labelledby="settings-title">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
            <SlidersHorizontal size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>設定</span>
          </div>
          <h1 id="settings-title" className="m-0 mt-2 font-serif text-[clamp(32px,7vw,48px)] font-normal leading-tight tracking-[-.04em]">
            Settings
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

      <div className="mt-7 grid gap-4">
        <SettingGroup id="dictionary-section" icon={BookOpen} title="Dictionary">
          <DictionarySourceManager application={importApplication} />
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
              onChange={(endpoint) => { updateLlm({ endpoint }) }}
            />
            <TextInput
              label="Model"
              name="llm-model"
              value={localLlm.model}
              placeholder="gpt-4o-mini"
              autoComplete="off"
              onChange={(model) => { updateLlm({ model }) }}
            />
            <TextInput
              label="API Key"
              name="llm-api-key"
              value={localLlm.apiKey}
              type="text"
              masked
              placeholder="sk-..."
              autoComplete="off"
              onChange={(apiKey) => { updateLlm({ apiKey }) }}
            />
            <p className="m-0 text-xs text-again" role="note">
              API キーは localStorage に保存されます。同じブラウザの他の拡張機能や XSS があれば読み取られる可能性があるので注意してください。
            </p>
          </div>
        </SettingGroup>

        <SettingGroup id="account-section" icon={User} title="Account">
          <AccountSection />
        </SettingGroup>
      </div>
    </main>
  )
}
