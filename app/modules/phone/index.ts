// The phone side of Tubelight (Android): actions a teammate asks for, the screen when the assistant was summoned,
// notification access, and the "Tubelight needs you" alert over the lock screen. Native: android/.../PhoneModule.kt.
import { requireOptionalNativeModule } from 'expo'

export interface PhoneAction {
  action: 'alarm' | 'timer' | 'call' | 'text' | 'whatsapp' | 'email' | 'navigate' | 'open_url' | 'search' | 'calendar' | 'open_app' | 'settings'
  title?: string; text?: string; number?: string; to?: string; place?: string; url?: string; app?: string
  hour?: number; minute?: number; seconds?: number; start?: number; end?: number
}
export interface Noted { key: string; app: string; title: string; text: string; at: number }

interface PhoneModule {
  /** Do it now (opens the app that does it, or does it silently for alarms and timers); what happened, in words. */
  act(a: PhoneAction): string
  /** "Galaxy S21 FE 5G": the phone's name in its settings. */
  deviceName(): string
  /** What was on screen when the assistant was summoned (once, only if from the last 20 s). */
  screenContext(): { app: string | null; text: string | null; image: string | null } | null
  /** Why the assistant panel was opened (a "needs you" alert): thread, reason… */
  launchArgs(): Record<string, string>
  isLocked(): boolean
  /** Full-screen alert over the lock screen; false when the phone is unlocked and in use. */
  ring(a: { title: string; body: string; thread?: string; reason?: string; approval?: string }): boolean
  clearRing(): void
  canRing(): boolean
  openRingSettings(): void
  notificationAccess(): boolean
  openNotificationAccess(): void
  recentNotifications(sinceMs: number): Noted[]
  /** Usage access (Settings → Usage access): lets status() say what's taking the storage. */
  usageAccess(): boolean
  openUsageAccess(): void
  /** Storage, battery, memory, network (and storage by kind and by app, with usage access). */
  status(): Record<string, unknown>
  /** The screen's corner radius in dp (0 if the phone doesn't say). */
  screenRadius(): number
  /** A local PDF (file:// URI): page count and each page's size in points. */
  pdfInfo(path: string): Promise<{ pages: number; sizes: [number, number][] }>
  /** One page drawn at `width` px into the cache (JPEG): its file URI and pixel size. */
  pdfPage(path: string, page: number, width: number): Promise<{ uri: string; width: number; height: number }>
  /** Close the open PDF. */
  pdfClose(): void
}

/** null in builds without the module (an older dev client). */
export const Phone = requireOptionalNativeModule<PhoneModule>('Phone')
