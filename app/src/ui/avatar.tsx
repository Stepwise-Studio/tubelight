import { createAvatar } from '@dicebear/core'
import * as notionists from '@dicebear/notionists'
import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { SvgXml } from 'react-native-svg'

import type { Teammate } from '@/lib/types'
import { useTheme } from '@/theme'

export type AvatarState = 'default' | 'working' | 'sleeping'

/** Faces offered in the teammate editor (besides their name's own). Stable seeds, so a rename keeps the face. */
export const FACE_SEEDS = ['Nova', 'Milo', 'Juno', 'Ezra', 'Iris', 'Otto', 'Remy', 'Luna', 'Kai', 'Zoe', 'Theo']

/**
 * Which face a teammate has. `avatar_shape` is `face:<seed>` once picked in the editor; older teammates
 * still carry a bot shape name there, and get the face their name draws.
 */
export const faceSeed = (t: Pick<Teammate, 'avatar_shape' | 'name'>) =>
  t.avatar_shape.startsWith('face:') ? t.avatar_shape.slice(5) : t.name || 'Teammate'

const svgs = new Map<string, string>()
/** DiceBear Notionists (CC0) on the teammate's colour, cached: the same few faces repeat across the app. */
function faceSvg(seed: string, color: string) {
  const key = `${seed}|${color}`
  let svg = svgs.get(key)
  if (!svg) {
    svg = createAvatar(notionists, { seed, backgroundColor: [color.replace('#', '')], radius: 50 }).toString()
    svgs.set(key, svg)
  }
  return svg
}

export interface TeammateAvatarProps {
  teammate: Pick<Teammate, 'avatar_shape' | 'color' | 'name'>
  size?: number
  /** `working` while the teammate has a live run: an accent ring, no motion. */
  state?: AvatarState
  interactive?: boolean
  /** Kept for callers from the animated avatars; the faces are static now. */
  paused?: boolean
  live?: boolean
  onPress?: () => void
}

/** Every teammate's face goes through here: a static DiceBear Notionists portrait. */
export const TeammateAvatar = memo(function TeammateAvatar({ teammate, size = 40, state = 'default', onPress }: TeammateAvatarProps) {
  const { c } = useTheme()
  const working = state === 'working'
  const face = (
    <View
      style={{ width: size, height: size, opacity: state === 'sleeping' ? 0.5 : 1 }}
      accessible
      accessibilityRole={onPress ? 'button' : 'image'}
      accessibilityLabel={working ? `${teammate.name}, working` : teammate.name}
    >
      <SvgXml xml={faceSvg(faceSeed(teammate), teammate.color)} width={size} height={size} />
      {working && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', inset: -3, borderRadius: size, borderWidth: 2, borderColor: c.tube }}
        />
      )}
    </View>
  )
  return onPress ? <Pressable onPress={onPress} hitSlop={6}>{face}</Pressable> : face
})
