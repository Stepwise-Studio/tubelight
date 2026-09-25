import * as Haptics from 'expo-haptics'
import { Platform } from 'react-native'

const on = Platform.OS !== 'web'

/** Haptics for meaningful moments only: send, approve, reject, long-press, errors. */
export const haptic = {
  tap: () => { if (on) Haptics.selectionAsync().catch(() => {}) },
  light: () => { if (on) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}) },
  medium: () => { if (on) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}) },
  success: () => { if (on) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}) },
  warning: () => { if (on) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}) },
  error: () => { if (on) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}) },
}
