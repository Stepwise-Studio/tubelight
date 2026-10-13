import * as Notifications from 'expo-notifications'
import { router } from 'expo-router'
import { useEffect } from 'react'
import { Platform } from 'react-native'

import { startClock, syncClock } from '@/lib/clock'
import { handleAction, pushData, registerBackgroundActions, setupNotifications } from '@/lib/notifications'

/** Notification taps and buttons: a tap opens its chat (`data.thread_id`); a button (Approve, Reply...) does its
 * thing without navigating (lib/notifications.ts). Channels, button sets and the background handler are set up
 * here too. Token registration lives in Profile. */
export function usePushRouting(enabled: boolean) {
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return
    setupNotifications().catch(() => {})
    registerBackgroundActions()
    startClock()
    const open = async (r: Notifications.NotificationResponse | null) => {
      if (!r) return
      const data = pushData(r.notification.request.content as { data?: unknown; dataString?: string })
      if (await handleAction(r.actionIdentifier, r.userText, data, r.notification.request.identifier)) return
      if (data.kind === 'clock') router.navigate({ pathname: '/tasks', params: { view: 'clock' } })
      else if (typeof data.thread_id === 'string') router.push({ pathname: '/chat/[threadId]', params: { threadId: data.thread_id } })
    }
    // At launch only a plain tap is replayed: a button (Approve, Reply) was already handled when it was pressed.
    const last = Notifications.getLastNotificationResponse()
    if (last?.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) open(last)
    const sub = Notifications.addNotificationResponseReceivedListener(open)
    // A teammate set an alarm or reminder while the app's open: arm it now.
    const got = Notifications.addNotificationReceivedListener((n) => { if (pushData(n.request.content).kind === 'clock') syncClock() })
    return () => { sub.remove(); got.remove() }
  }, [enabled])
}
