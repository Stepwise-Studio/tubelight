import * as Notifications from 'expo-notifications'
import { router } from 'expo-router'
import { useEffect } from 'react'
import { Platform } from 'react-native'

/** A tap on a push notification opens its thread (`data.thread_id`). Token registration lives in Settings. */
export function usePushRouting(enabled: boolean) {
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return
    const open = (r: Notifications.NotificationResponse | null) => {
      const id = r?.notification.request.content.data?.thread_id
      if (typeof id === 'string') router.push({ pathname: '/chat/[threadId]', params: { threadId: id } })
    }
    open(Notifications.getLastNotificationResponse())
    const sub = Notifications.addNotificationResponseReceivedListener(open)
    return () => sub.remove()
  }, [enabled])
}
