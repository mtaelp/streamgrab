import type { StreamGrabRendererApi } from '../preload/shell-preload'

declare global {
  interface Window {
    streamgrab: StreamGrabRendererApi
  }
}

export {}
