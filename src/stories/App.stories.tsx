import type { Meta, StoryObj } from '@storybook/react'
import App, { type AppProps } from '../App'
import { MockAuthProvider } from '../auth'

type Story = StoryObj<typeof App>

const meta = {
  title: 'lime / App',
  component: App,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof App>

export default meta

const render = (args: AppProps) => (
  <MockAuthProvider>
    <App {...args} />
  </MockAuthProvider>
)

export const 今日: Story = {
  args: { initialRoute: 'today' },
  render,
}

export const 読解: Story = {
  args: { initialRoute: 'reading' },
  render,
}

export const 設定: Story = {
  args: { initialRoute: 'settings' },
  render,
}
