import { useState } from 'react'
import { TextInput } from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { FadeIn, FadeOut, interpolate, useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp02Icon, StopIcon } from '@hugeicons/core-free-icons'

import type { Teammate } from '@/lib/types'
import { motion, radius, type as typeScale, useTheme } from '@/theme'
import { Beam, IconButton, ListRow, Squircle, TeammateAvatar, Text, elevation, haptic } from '@/ui'

const MENTION = /(^|\s)@([a-z0-9_-]*)$/i

export interface ComposerProps {
  placeholder: string
  /** Project members for @mentions. Empty in DMs (no picker). */
  members: Teammate[]
  live: boolean
  onSend: (text: string, mentions: string[]) => void
  onStop: () => Promise<unknown> | void
}

/**
 * Auto-growing input in a squircle. `@` opens a member picker above it; send turns into Stop
 * while a run is live (and the input is empty). Rides the keyboard; safe-area aware.
 */
export function Composer({ placeholder, members, live, onSend, onStop }: ComposerProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const kb = useReanimatedKeyboardAnimation()
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const [stopping, setStopping] = useState(false)

  const before = text.slice(0, sel)
  const query = members.length ? before.match(MENTION)?.[2]?.toLowerCase() : undefined
  const matches = query === undefined ? [] : members.filter((m) => m.handle.startsWith(query) || m.name.toLowerCase().startsWith(query))

  const pad = useAnimatedStyle(() => ({ paddingBottom: interpolate(kb.progress.value, [0, 1], [Math.max(insets.bottom, 10), 10]) }))

  const insert = (t: Teammate) => {
    haptic.tap()
    const start = before.replace(MENTION, (_m, space) => `${space}@${t.handle} `)
    setText(start + text.slice(sel))
    setSel(start.length)
  }

  const send = () => {
    const body = text.trim()
    if (!body) return
    haptic.light()
    const mentions = members.filter((m) => new RegExp(`(^|\\s)@${m.handle}\\b`, 'i').test(body)).map((m) => m.id)
    onSend(body, mentions)
    setText('')
    setSel(0)
  }

  const showStop = live && !text.trim()
  const canSend = !!text.trim()

  const field = (
    <Squircle style={{ borderRadius: radius.xl, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 14, paddingRight: 4, paddingVertical: 4 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        onSelectionChange={(e) => setSel(e.nativeEvent.selection.end)}
        placeholder={placeholder}
        placeholderTextColor={c.ink4}
        selectionColor={c.tube}
        cursorColor={c.tube}
        keyboardAppearance={scheme}
        multiline
        accessibilityLabel={placeholder}
        style={[typeScale.body, { flex: 1, color: c.ink, minHeight: 36, maxHeight: 140, paddingTop: 8, paddingBottom: 8, textAlignVertical: 'center' }]}
        maxFontSizeMultiplier={1.3}
      />
      <IconButton
        icon={showStop ? StopIcon : ArrowUp02Icon}
        swapKey={showStop ? 'stop' : 'send'}
        accessibilityLabel={showStop ? 'Stop the teammate' : 'Send'}
        variant={showStop ? 'solid' : canSend ? 'tube' : 'soft'}
        size={36}
        iconSize={18}
        disabled={showStop ? stopping : !canSend}
        onPress={async () => {
          if (!showStop) return send()
          haptic.medium()
          setStopping(true)
          await onStop()
          setStopping(false)
        }}
        style={{ marginLeft: 4 }}
      />
    </Squircle>
  )

  return (
    <Animated.View style={[{ paddingHorizontal: 10, paddingTop: 8, backgroundColor: c.canvas }, pad]}>
      {matches.length > 0 && (
        <Animated.View
          entering={FadeIn.duration(motion.duration.fast)}
          exiting={FadeOut.duration(motion.duration.quick)}
          style={[{ position: 'absolute', left: 10, right: 10, bottom: '100%', borderRadius: radius.lg }, elevation(scheme, 2)]}
        >
          <Squircle style={{ borderRadius: radius.lg, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 4 }} accessibilityRole="menu">
            <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 2 }}>Mention a teammate</Text>
            {matches.slice(0, 5).map((m) => (
              <ListRow
                key={m.id}
                title={m.name}
                subtitle={`@${m.handle} · ${m.role}`}
                leading={<TeammateAvatar teammate={m} size={28} interactive={false} />}
                onPress={() => insert(m)}
                style={{ minHeight: 48 }}
              />
            ))}
          </Squircle>
        </Animated.View>
      )}
      {/* Always wrapped, so a run starting never remounts the input (keeps focus). */}
      <Beam radius={radius.xl} active={live}>{field}</Beam>
    </Animated.View>
  )
}
