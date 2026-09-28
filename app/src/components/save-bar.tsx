import { View } from 'react-native'
import Animated, { Keyframe } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { motion } from '@/theme'
import { Button, Surface, Text } from '@/ui'

const barIn = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: motion.distance.base }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: motion.ease.smoothOut },
}).duration(motion.duration.fast)
const barOut = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  100: { opacity: 0, transform: [{ translateY: motion.distance.base }], easing: motion.ease.smoothOut },
}).duration(motion.duration.quick)

/** Floating "Unsaved changes" bar for edit-in-place screens: render it while there are changes. Screens pad their
 * scroll content by SAVE_BAR_SPACE while it shows. */
export function SaveBar({ body, saving, onDiscard, onSave }: { body: string; saving: boolean; onDiscard: () => void; onSave: () => void }) {
  const insets = useSafeAreaInsets()
  return (
    <Animated.View
      entering={barIn}
      exiting={barOut}
      style={{ position: 'absolute', zIndex: 10, left: 12, right: 12, bottom: Math.max(insets.bottom, 12), borderRadius: 24, boxShadow: '0 8px 24px -6px rgba(0,0,0,0.25)' }}
    >
      {/* A heading and one line of context, then the two choices side by side at full width. */}
      <Surface radius={24} padding={16} style={{ gap: 14 }} accessibilityRole="alert">
        <View style={{ gap: 2 }}>
          <Text variant="headline">Unsaved changes</Text>
          <Text variant="caption" color="ink3">{body}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label="Discard" variant="outline" onPress={onDiscard} style={{ flex: 1 }} />
          <Button label="Save changes" loading={saving} onPress={onSave} style={{ flex: 1 }} />
        </View>
      </Surface>
    </Animated.View>
  )
}

export const SAVE_BAR_SPACE = 170
