import { createAvatar } from '@dicebear/core'
import * as notionists from '@dicebear/notionists'
import { Skia } from '@shopify/react-native-skia'
import { memo } from 'react'
import { Image, PixelRatio, Pressable, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { LaptopIcon } from '@hugeicons/core-free-icons'

import type { Teammate } from '@/lib/types'
import { useTheme } from '@/theme'

import { Icon } from './icon'

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

const pngs = new Map<string, string | null>()
/**
 * The face as a PNG data URI, drawn once per seed, colour and size with Skia's native SVG renderer and cached.
 * Plain images decode off the JS thread and scroll for free; a dozen live SVG trees stalled the teammate sheet.
 * null when Skia can't draw it (then the SVG is used).
 */
function facePng(seed: string, color: string, size: number) {
  const px = Math.round(size * PixelRatio.get())
  const key = `${seed}|${color}|${px}`
  if (pngs.has(key)) return pngs.get(key)!
  let uri: string | null = null
  try {
    const svg = Skia.SVG.MakeFromString(faceSvg(seed, color))
    const surface = svg && Skia.Surface.Make(px, px)
    if (svg && surface) {
      surface.getCanvas().drawSvg(svg, px, px)
      uri = `data:image/png;base64,${surface.makeImageSnapshot().encodeToBase64()}`
    }
  } catch {
    uri = null
  }
  pngs.set(key, uri)
  return uri
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
  const device = teammate.avatar_shape.startsWith('device:')  // a linked computer's own chat (agent computers.py)
  const png = device ? null : facePng(faceSeed(teammate), teammate.color, size)
  const face = (
    <View
      style={{ width: size, height: size, opacity: state === 'sleeping' ? 0.5 : 1 }}
      accessible
      accessibilityRole={onPress ? 'button' : 'image'}
      accessibilityLabel={working ? `${teammate.name}, working` : teammate.name}
    >
      {device ? (
        <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.panel3, alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={LaptopIcon} size={Math.round(size * 0.52)} color="ink2" />
        </View>
      ) : png ? (
        <Image source={{ uri: png }} style={{ width: size, height: size }} fadeDuration={0} />
      ) : (
        <SvgXml xml={faceSvg(faceSeed(teammate), teammate.color)} width={size} height={size} />
      )}
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
