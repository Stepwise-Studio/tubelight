import { memo } from 'react'
import { Image, Pressable, View } from 'react-native'
import { LaptopIcon, SmartPhone01Icon } from '@hugeicons/core-free-icons'

import type { Teammate } from '@/lib/types'
import { useTheme } from '@/theme'

import { Icon } from './icon'

export type AvatarState = 'default' | 'working' | 'sleeping'

/** Tubelight's own hand-drawn faces (`assets/avatars`, ink on transparent, drawn on the teammate's colour). */
const FACES = {
  bob: require('../../assets/avatars/bob.png'),
  hoodie: require('../../assets/avatars/hoodie.png'),
  wavy: require('../../assets/avatars/wavy.png'),
  boy: require('../../assets/avatars/boy.png'),
  braid: require('../../assets/avatars/braid.png'),
  glasses: require('../../assets/avatars/glasses.png'),
  ponytail: require('../../assets/avatars/ponytail.png'),
  cap: require('../../assets/avatars/cap.png'),
  curly: require('../../assets/avatars/curly.png'),
  puppy: require('../../assets/avatars/puppy.png'),
  husky: require('../../assets/avatars/husky.png'),
  cat: require('../../assets/avatars/cat.png'),
}
export type Face = keyof typeof FACES
/** Faces offered in the teammate editor. Same list and order as the agent's `push.FACES`. */
export const FACE_SEEDS = Object.keys(FACES) as Face[]

/**
 * Which face a teammate has. `avatar_shape` is `face:<face>` once picked in the editor; anything else (older
 * seeds, legacy bot shapes) maps to a face by a hash of the seed, the same one the agent uses for notifications.
 */
export const faceSeed = (t: Pick<Teammate, 'avatar_shape' | 'name'>): Face => {
  const seed = t.avatar_shape.startsWith('face:') ? t.avatar_shape.slice(5) : t.name || 'Teammate'
  if (seed in FACES) return seed as Face
  let h = 0
  for (const ch of seed) h += ch.codePointAt(0)!
  return FACE_SEEDS[h % FACE_SEEDS.length]
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

/** Every teammate's face goes through here: a static hand-drawn portrait on their colour. */
export const TeammateAvatar = memo(function TeammateAvatar({ teammate, size = 40, state = 'default', onPress }: TeammateAvatarProps) {
  const { c } = useTheme()
  const working = state === 'working'
  // A linked computer's own chat (agent computers.py) or the phone's (agent phone.py): an icon, not a face.
  const phone = teammate.avatar_shape === 'phone'
  const device = phone || teammate.avatar_shape.startsWith('device:')
  const face = (
    <View
      style={{ width: size, height: size, opacity: state === 'sleeping' ? 0.5 : 1 }}
      accessible
      accessibilityRole={onPress ? 'button' : 'image'}
      accessibilityLabel={working ? `${teammate.name}, working` : teammate.name}
    >
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: teammate.color || '#64748b', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {device ? (
          <Icon icon={phone ? SmartPhone01Icon : LaptopIcon} size={Math.round(size * 0.5)} color="#ffffff" strokeWidth={1.75} />
        ) : (
          <Image source={FACES[faceSeed(teammate)]} style={{ width: size, height: size }} fadeDuration={0} />
        )}
      </View>
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
