import type { Preview } from '@storybook/react'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/newsreader/400.css'
import '@fontsource/newsreader/500.css'
import '../src/index.css'

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'dark',
      values: [{ name: 'dark', value: '#151714' }],
    },
    layout: 'centered',
    controls: { expanded: true },
  },
}

export default preview
