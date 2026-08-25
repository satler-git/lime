import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import { MockAuthProvider } from '../auth'
import { isLimeRoute, limeRouteToPath, type LimeRoute } from '../routes'

type StoryArgs = { initialRoute?: LimeRoute }
type Story = StoryObj<StoryArgs>

const meta: Meta<StoryArgs> = {
  title: 'lime / App',
  component: App,
  parameters: { layout: 'fullscreen' },
}

export default meta

const render = ({ initialRoute }: StoryArgs) => (
  <MockAuthProvider>
    <MemoryRouter
      initialEntries={[
        initialRoute !== undefined && isLimeRoute(initialRoute)
          ? limeRouteToPath(initialRoute)
          : '/',
      ]}
    >
      <App />
    </MemoryRouter>
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

export const カード: Story = {
  args: { initialRoute: 'cards' },
  render,
}
