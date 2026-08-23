import type { Meta, StoryObj } from '@storybook/react'

const meta = {
  title: 'lime / 確認ポイント',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const 使い方: Story = {
  render: () => (
    <div className="max-w-[560px] text-text">
      <h1 className="m-0 mb-[18px] font-serif text-[34px] font-normal">このカタログで確認すること</h1>
      <ul>
        <li className="my-[7px] leading-relaxed text-text-muted">文章を <strong>DictionaryText</strong> に渡すと、全ての英単語が辞書対象になる</li>
        <li className="my-[7px] leading-relaxed text-text-muted">単語のダブルクリックで辞書 popup を開く</li>
        <li className="my-[7px] leading-relaxed text-text-muted"><strong>new / review</strong> の印は学習対象の区別だけに使う</li>
        <li className="my-[7px] leading-relaxed text-text-muted">例文でも entry の単語をハイライトし、他の単語も辞書対象にする</li>
        <li className="my-[7px] leading-relaxed text-text-muted">辞書 popup では、SRS 未登録語は追加、登録済み語は評価を表示する</li>
        <li className="my-[7px] leading-relaxed text-text-muted">読了後の一括追加は、読中に調べた未登録語だけを扱う</li>
      </ul>
    </div>
  ),
}
