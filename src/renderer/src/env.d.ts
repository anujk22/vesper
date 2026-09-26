import type { VesperApi } from '../../preload'

declare global {
  interface Window {
    bluevis: VesperApi
  }
}

export {}
