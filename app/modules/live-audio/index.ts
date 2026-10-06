// Full-duplex voice audio (Android): 16 kHz mic PCM out with echo cancellation, 24 kHz PCM in, instant flush.
import { requireNativeModule } from 'expo'

type EventSubscription = { remove(): void }

type Events = {
  onMic: (e: { data: string }) => void
  /** RMS and the three voice bands (0–1, an AnalyserNode's byte spectrum averaged over 80–300, 300–2000, 2000–6000 Hz). */
  onInputLevel: (e: { level: number; bands?: number[] }) => void
  onOutputLevel: (e: { level: number; bands?: number[] }) => void
  onPlayback: (e: { playing: boolean }) => void
  onInterruption: (e: { reason: string }) => void
}

interface LiveAudioModule {
  start(): Promise<void>
  stop(): void
  /** Queue base64 PCM16 24 kHz mono for playback. */
  play(base64: string): void
  /** Drop everything queued or buffered (the model was interrupted). */
  clear(): void
  setMuted(muted: boolean): void
  addListener<K extends keyof Events>(event: K, listener: Events[K]): EventSubscription
}

export const LiveAudio = requireNativeModule<LiveAudioModule>('LiveAudio')
