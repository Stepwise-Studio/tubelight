import { View } from 'react-native'

import { BotAvatar } from '@/vendor/bot-avatars-native'
import type { Teammate } from '@/lib/types'

export type AvatarState = 'default' | 'working' | 'sleeping'

export interface TeammateAvatarProps {
  teammate: Pick<Teammate, 'avatar_shape' | 'color' | 'name'>
  size?: number
  /** `working` while the teammate has a live run. */
  state?: AvatarState
  /** Tap to hop (the libraries.dev delight). Off inside pressable rows so the row gets the tap. */
  interactive?: boolean
  /** Freeze animation (e.g. avatars deep in a scrolled thread). */
  paused?: boolean
  onPress?: () => void
}

/** Every teammate's face goes through here (libraries.dev bot-avatars, Skia). */
export function TeammateAvatar({ teammate, size = 40, state = 'default', interactive = true, paused, onPress }: TeammateAvatarProps) {
  return (
    <View style={{ width: size, height: size }} pointerEvents={interactive || onPress ? 'auto' : 'none'}>
      <BotAvatar
        type={teammate.avatar_shape}
        color={teammate.color}
        size={size}
        state={state}
        paused={paused}
        interactive={interactive}
        onPress={onPress}
        jumpEvery={state === 'working' ? 8 : 0}
        accessibilityLabel={state === 'working' ? `${teammate.name}, working` : teammate.name}
      />
    </View>
  )
}
