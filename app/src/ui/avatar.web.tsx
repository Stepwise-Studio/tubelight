// Web preview: the web bot-avatars package draws on a DOM canvas, no Skia/CanvasKit needed.
import { BotAvatar } from 'bot-avatars'
import { View } from 'react-native'

import type { TeammateAvatarProps } from './avatar'

export type { AvatarState, TeammateAvatarProps } from './avatar'

export function TeammateAvatar({ teammate, size = 40, state = 'default', interactive = true, paused, onPress }: TeammateAvatarProps) {
  return (
    <View style={{ width: size, height: size }} accessibilityLabel={state === 'working' ? `${teammate.name}, working` : teammate.name}>
      <BotAvatar
        type={teammate.avatar_shape}
        color={teammate.color}
        size={size}
        state={state}
        paused={paused}
        interactive={interactive}
        onClick={onPress}
        jumpEvery={state === 'working' ? 8 : 0}
      />
    </View>
  )
}
