import type { Meta, StoryObj } from '@storybook/react'
import App from '../App'

type Story = StoryObj<typeof App>

const meta = {
  title: 'lime / App',
  component: App,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof App>

export default meta

export const 今日: Story = {
  args: { initialRoute: 'today' },
}

export const 読解: Story = {
  args: { initialRoute: 'reading' },
}

export const 設定: Story = {
  args: { initialRoute: 'settings' },
}
