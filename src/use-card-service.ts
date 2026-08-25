import { useEffect, useState } from 'react'
import { CardService } from './application/card-service'
import { IndexedDbCardRepository } from './persistence/indexed-db-card-repository'
import { FsrsScheduler } from './scheduling/fsrs-scheduler'

export type UseCardServiceResult = {
  cardService: CardService | undefined
  repository: IndexedDbCardRepository | undefined
  isLoading: boolean
}

export function useCardService(userId?: string): UseCardServiceResult {
  const [isLoading, setIsLoading] = useState(true)
  const [repository, setRepository] = useState<IndexedDbCardRepository | undefined>(undefined)
  const [cardService, setCardService] = useState<CardService | undefined>(undefined)

  useEffect(() => {
    setIsLoading(true)
    setRepository(undefined)
    setCardService(undefined)

    if (globalThis.indexedDB == null) {
      setIsLoading(false)
      return
    }

    const repo = new IndexedDbCardRepository(
      userId !== undefined && userId.length > 0 ? { userId } : undefined,
    )
    setRepository(repo)
    setCardService(new CardService(repo, new FsrsScheduler()))
    setIsLoading(false)

    return () => {
      void repo.close()
    }
  }, [userId])

  return { cardService, repository, isLoading }
}
