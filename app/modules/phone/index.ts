// The phone side of Tubelight (Android): actions a teammate asks for, the screen when the assistant was summoned,
// notification access, and the "Tubelight needs you" alert over the lock screen. Native: android/.../PhoneModule.kt.
import { requireOptionalNativeModule } from 'expo'

export interface PhoneAction {
  action: 'alarm' | 'alarms' | 'alarm_off' | 'snooze' | 'timer' | 'timers' | 'timer_off' | 'call' | 'text' | 'sms' | 'reply'
    | 'whatsapp' | 'email' | 'navigate' | 'open_url' | 'search' | 'calendar' | 'open_app' | 'settings' | 'panel'
    | 'flashlight' | 'volume' | 'dnd' | 'brightness' | 'media' | 'play' | 'photo' | 'use_app'
  title?: string; text?: string; number?: string; name?: string; to?: string; place?: string; url?: string; app?: string
  key?: string; level?: number; goal?: string; inputs?: string[]; done_when?: string
  hour?: number; minute?: number; seconds?: number; start?: number; end?: number
}
export interface AppScreen { snapshot?: string; app?: string; text?: string; status?: string; did?: string; why?: string }
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
  /** Using apps (Settings → Accessibility → Tubelight), Apps.kt: the app in front as elements, acted on by id. */
  appsOn(): boolean
  openAppsAccess(): void
  appLook(): Promise<AppScreen>
  appAct(snapshot: string, element: string, action: string, value: string): Promise<AppScreen>
  appKey(key: string): Promise<AppScreen>
  appOpen(app: string): Promise<AppScreen>
  /** The call stand-in (Calls.kt): on, and whether it can answer calls and switch accessibility on just for a call. */
  standIn(): { on: boolean; answer: boolean; access: boolean }
  setStandIn(on: boolean): void
  callState(): 'ringing' | 'active' | 'idle'
  callAnswer(): void
  callHangUp(): void
  /** The call on the speaker (loud) or back; true when it took. */
  callSpeaker(on: boolean): boolean
  /** Tubelight's accessibility on for the call / off after (only with the one-time USB grant); whether it's on. */
  standInAccess(on: boolean): boolean
  canDnd(): boolean
  openDndAccess(): void
  canBrightness(): boolean
  openBrightnessAccess(): void
  notificationAccess(): boolean
  openNotificationAccess(): void
  recentNotifications(sinceMs: number): Noted[]
  /** Usage access (Settings → Usage access): lets status() say what's taking the storage. */
  usageAccess(): boolean
  openUsageAccess(): void
  /** Storage, battery, memory, network (and storage by kind and by app, with usage access). */
  status(): Promise<Record<string, unknown>>
  /** The screen's corner radius in dp (0 if the phone doesn't say). */
  screenRadius(): number
  /** A local PDF (file:// URI): page count and each page's size in points. */
  pdfInfo(path: string): Promise<{ pages: number; sizes: [number, number][] }>
  /** One page drawn at `width` px into the cache (JPEG): its file URI and pixel size. */
  pdfPage(path: string, page: number, width: number): Promise<{ uri: string; width: number; height: number }>
  /** Matches of `query` (Android 15+): page index, boxes in page points [l, t, r, b], and a line of text around it.
   * Throws on older Android. */
  pdfSearch?(path: string, query: string, limit: number): Promise<{ page: number; rects: [number, number, number, number][]; text: string }[]>
  /** Close the open PDF. */
  pdfClose(): void
  /** A file another app opened with Tubelight (content:// or file://), copied into the cache. */
  openFile(uri: string): Promise<{ uri: string; name: string; size: number; mime: string }>
}

/** null in builds without the module (an older dev client). */
export const Phone = requireOptionalNativeModule<PhoneModule>('Phone')
