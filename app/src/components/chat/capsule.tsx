// The small centred pill for things that happened in a chat (follow-ups, automations, decided approvals). One line
// "Head: rest"; tapping opens the whole story in a sheet (or the caller's own screen, e.g. an automation).
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'

import { fonts, useTheme } from '@/theme'
import { Chip, Press, Sheet, Squircle, Text, type ChipColor } from '@/ui'

export type Tone = 'neutral' | 'tube' | 'success' | 'warning' | 'danger'
const CHIP: Record<Tone, ChipColor> = { neutral: 'idle', tube: 'info', success: 'success', warning: 'warning', danger: 'danger' }

export function Capsule({ text, tone = 'neutral', onPress, detail }: {
  text: string
  tone?: Tone
  /** Opens something of its own (an automation). Otherwise the capsule opens `detail` (or its full text) in a sheet. */
  onPress?: () => void
  /** What the sheet shows below the text: the approved command, when, a note. */
  detail?: ReactNode
}) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const bg = tone === 'neutral' ? c.panel2 : c[`${tone}Soft`]
  const ink = tone === 'neutral' ? c.ink2 : c[tone]
  const cut = text.indexOf(': ')
  const [head, rest] = cut > 0 ? [text.slice(0, cut), text.slice(cut + 2)] : [text, '']
  return (
    <View style={{ alignItems: 'center', paddingVertical: 8, paddingHorizontal: 32 }}>
      <Press radius={14} static onPress={onPress ?? (() => setOpen(true))} accessibilityLabel={text} accessibilityHint="Shows all of it">
        <Squircle style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, backgroundColor: bg }}>
          <Text variant="footnote" color="ink3" numberOfLines={1} style={{ textAlign: 'center' }}>
            <Text variant="footnote" style={{ fontFamily: fonts.medium, color: ink }}>{head}</Text>
            {rest ? `: ${rest}` : ''}
          </Text>
        </Squircle>
      </Press>
      {!onPress && (
        <Sheet open={open} onClose={() => setOpen(false)} accessibilityLabel={text}>
          {/* Status chip, then what it was about (the headline), then the details, the quietest last. */}
          <View style={{ paddingHorizontal: 20, paddingBottom: 28, gap: 16 }}>
            <View style={{ gap: 10, alignItems: 'flex-start' }}>
              <Chip label={head} color={CHIP[tone]} variant="soft" size="sm" dot />
              {!!rest && <Text variant="heading" selectable>{rest}</Text>}
            </View>
            {detail}
          </View>
        </Sheet>
      )}
    </View>
  )
}
