import type { CraftDeskApi } from './index'

declare global {
  interface Window {
    api: CraftDeskApi
  }
}

export {}
