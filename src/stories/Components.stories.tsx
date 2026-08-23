import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { BatchAddPanel } from '../components/BatchAddPanel'
import { DictionaryPopover } from '../components/DictionaryPopover'
import { DictionaryText } from '../components/DictionaryText'
import { QuizCard } from '../components/QuizCard'
import { RatingGroup } from '../components/RatingGroup'
import { ReadingProgress } from '../components/ReadingProgress'
import { TodayOverview } from '../components/TodayOverview'
import type { Rating } from '../domain/card'
import type { TargetWordData, WordAnchor } from '../components/types'

const meta = {
  title: 'lime / コンポーネント',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>
type OpenPopup = { word: TargetWordData; anchor: WordAnchor }

const resilient: TargetWordData = {
  word: 'resilient', pronunciation: '/rɪˈzɪliənt/', partOfSpeech: '形容詞', kind: 'new', inSrs: false,
  definition: '困難や変化のあとに、すぐに回復できる性質',
  examples: ['Small communities can be remarkably resilient when resources are scarce.', 'The resilient grass returned after the long drought.'],
}

const secular: TargetWordData = {
  word: 'secular', pronunciation: '/ˈsekjələr/', partOfSpeech: '形容詞', kind: 'review', inSrs: true,
  definition: '宗教や精神的な事柄に関係しない',
  examples: ['The museum tells a secular story about how the city grew around the river.'],
}

const quiet: TargetWordData = {
  word: 'quiet', pronunciation: '/ˈkwaɪət/', partOfSpeech: '形容詞', inSrs: true,
  definition: '音や動きが少ない', examples: ['The street was quiet after sunset.'],
}

export const 今日の学習: Story = {
  render: function TodayOverviewStory() {
    const [started, setStarted] = useState(false)
    return <div className="min-h-screen w-full bg-background"><TodayOverview onStartReading={() => setStarted(true)} />{started && <p className="fixed inset-x-0 bottom-4 text-center text-xs text-accent" role="status">読解を開始します</p>}</div>
  },
}

export const 読解の進み具合: Story = {
  render: () => <div style={{ width: 'min(100%, 420px)' }}><ReadingProgress /></div>,
}

export const 全ての単語が辞書対象: Story = {
  render: function DictionaryInteractionStory() {
    const [stack, setStack] = useState<OpenPopup[]>([])
    const [added, setAdded] = useState(false)
    const newWord = { ...resilient, inSrs: added }
    const entries: Record<string, TargetWordData> = { quiet, resilient: newWord, secular }
    const openWord = (selected: string, anchor: WordAnchor) => {
      setStack((current) => [...current, { word: entries[selected.toLocaleLowerCase()] ?? { ...quiet, word: selected, inSrs: true }, anchor }])
    }
    const closeInner = () => setStack((current) => current.slice(0, -1))
    return (
      <div className="relative min-h-[260px] max-w-[660px] rounded-[10px] border border-line bg-background p-[clamp(18px,4vw,34px)]">
        <p className="mb-[26px] text-xs leading-normal text-text-faint">全ての英単語をダブルクリックできます。popup 内の例文語も、その単語の位置に開きます。外側をクリックすると内側から閉じます。</p>
        <p className="m-0 max-w-[560px] font-serif text-[clamp(20px,3vw,25px)] leading-[1.65] text-text">
          <DictionaryText text="A quiet river can make a city more resilient. Its secular history remains visible." targetWords={{ resilient: 'new', secular: 'review' }} onOpen={openWord} />
        </p>
        {stack.map((popup, index) => <DictionaryPopover key={`${popup.word.word}-${index}`} word={popup.word} anchor={popup.anchor} onClose={closeInner} onOpenWord={openWord} onAddToSrs={() => { setAdded(true); setStack((current) => current.map((item, itemIndex) => itemIndex === current.length - 1 ? { ...item, word: { ...item.word, inSrs: true } } : item)) }} />)}
      </div>
    )
  },
}

export const 辞書ポップアップ: Story = {
  render: function DictionaryStory() {
    const [rating, setRating] = useState<Rating>()
    const [added, setAdded] = useState(false)
    const [exampleWord, setExampleWord] = useState<{ word: string; anchor: WordAnchor }>()
    const example = <DictionaryText text="Small communities can be remarkably resilient when resources are scarce." entry="resilient" onOpen={(selected, anchor) => setExampleWord({ word: selected, anchor })} />
    const displayedWord = exampleWord ? { ...resilient, word: exampleWord.word, inSrs: true, definition: '例文中の単語を開いた状態' } : { ...resilient, examples: [example], inSrs: added }
    return <div className="relative min-h-[560px] max-w-[660px] rounded-[10px] border border-line bg-background p-4"><DictionaryPopover word={displayedWord} anchor={exampleWord?.anchor} rating={rating} onRate={setRating} onUndo={() => setRating(undefined)} onClose={() => setExampleWord(undefined)} onOpenWord={(selected, anchor) => setExampleWord({ word: selected, anchor })} onAddToSrs={() => setAdded(true)} /></div>
  },
}

export const 評価ボタン: Story = {
  render: function RatingsStory() {
    const [rating, setRating] = useState<Rating>('hard')
    return <div style={{ maxWidth: 360 }}><RatingGroup value={rating} onChange={setRating} /></div>
  },
}

export const 読解チェック: Story = {
  render: function QuizStory() {
    const [answer, setAnswer] = useState<string>()
    return <div style={{ maxWidth: 620 }}><QuizCard question="Why did the residents build a temporary crossing?" relatedWord="makeshift" selectedId={answer} correctId="b" options={[{ id: 'a', text: 'The old footpath was damaged by a flood' }, { id: 'b', text: 'They needed a quick way across while waiting for a permanent one' }, { id: 'c', text: 'The river changed its course' }, { id: 'd', text: 'The railway bridge was closed for repairs' }]} onSelect={setAnswer} /></div>
  },
}

export const 読了後の一括追加: Story = {
  render: function BatchStory() {
    const [selected, setSelected] = useState(['tributary'])
    const candidates = [{ word: 'tributary', context: 'a smaller river flowing into a larger one' }, { word: 'makeshift', context: 'temporary and improvised' }, { word: 'stewardship', context: 'careful management of something valuable' }]
    return <div style={{ maxWidth: 360 }}><BatchAddPanel candidates={candidates} selected={selected} onToggle={(word) => setSelected((current) => current.includes(word) ? current.filter((item) => item !== word) : [...current, word])} /></div>
  },
}
