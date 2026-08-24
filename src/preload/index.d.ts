import type { PupilApi } from './index'

declare global {
  interface Window {
    pupil: PupilApi
  }
}

export {}
