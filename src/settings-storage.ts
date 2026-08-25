export type LlmConfig = {
  endpoint: string
  model: string
  apiKey: string
}

export type StoredSettings = {
  reviewLimit: number
  newLimit: number
  llmConfig: LlmConfig
}

const STORAGE_KEY = 'lime-settings-v1'

const isLlmConfig = (value: unknown): value is LlmConfig => {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.endpoint === 'string' &&
    typeof record.model === 'string' &&
    typeof record.apiKey === 'string'
  )
}

const isNonNegativeInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
)

export function loadSettings(): Partial<StoredSettings> | undefined {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return undefined
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return undefined

    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined

    const record = parsed as Record<string, unknown>
    const settings: Partial<StoredSettings> = {}

    if (isNonNegativeInteger(record.reviewLimit)) {
      settings.reviewLimit = record.reviewLimit
    }

    if (isNonNegativeInteger(record.newLimit)) {
      settings.newLimit = record.newLimit
    }

    if (isLlmConfig(record.llmConfig)) {
      settings.llmConfig = { ...record.llmConfig, apiKey: '' }
    }

    return settings
  } catch {
    return undefined
  }
}

export function saveSettings(settings: StoredSettings): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return
  }

  try {
    const storable: StoredSettings = {
      ...settings,
      llmConfig: { ...settings.llmConfig, apiKey: '' },
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storable))
  } catch {
    // Ignore private-mode or quota errors; the app still works in memory.
  }
}
