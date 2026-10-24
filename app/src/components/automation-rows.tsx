import { View } from 'react-native'
import { RepeatIcon, ZapIcon } from '@hugeicons/core-free-icons'

import { RowWithAction } from '@/components/form-bits'
import { openAutomation, timing, whenText, type Automation, type RunOutcome } from '@/lib/automations'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Divider, Icon, Surface, Text, Toggle } from '@/ui'

/** The icon tile an automation wears everywhere: a repeat for schedules, a bolt for app events; tinted while on. */
export function AutomationGlyph({ a, size = 36 }: { a: Pick<Automation, 'kind' | 'enabled'>; size?: number }) {
  const { c } = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: a.enabled ? c.tubeSoft : c.panel2, alignItems: 'center', justifyContent: 'center' }}>
      <Icon icon={a.kind === 'app' ? ZapIcon : RepeatIcon} size={Math.round(size * 0.47)} color={a.enabled ? 'tube' : 'ink3'} />
    </View>
  )
}

/** How the last runs went, oldest to newest, as dots: posted lit, quiet faint, failed red, waiting amber. */
export function RunDots({ recent }: { recent: RunOutcome[] }) {
  const { c } = useTheme()
  const tint: Partial<Record<RunOutcome, string>> = { posted: c.tube, quiet: c.ink3, failed: c.danger, approval: c.warning, working: c.warning }
  if (!recent.length) return null
  return (
    <View style={{ flexDirection: 'row', gap: 3 }} accessibilityLabel={`Last runs: ${[...recent].reverse().join(', ')}`}>
      {[...recent].reverse().map((o, i) => (
        <View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tint[o] ?? c.line, opacity: o === 'quiet' ? 0.45 : 1 }} />
      ))}
    </View>
  )
}

/** A card of automations: name, when, who or where, next run; the switch pauses, the row opens it.
 * show: 'who' where the chat is already known (a project), 'where' where the teammate is (their profile). */
export function AutomationRows({ items, show, onToggle }: {
  items: Automation[]
  show: 'who' | 'where'
  onToggle: (a: Automation, on: boolean) => void
}) {
  const ws = useWorkspace()
  const context = (a: Automation) => show === 'who'
    ? ws.teammate(a.teammate_id)?.name ?? 'A teammate'
    : a.thread_id.startsWith('dm:') ? 'Direct chat' : ws.threadTitle(a.thread_id)
  return (
    <Surface style={{ overflow: 'hidden' }}>
      {items.map((a, i) => {
        const sub = [a.problems?.length ? 'Needs attention' : null, whenText(a), context(a), timing(a)].filter(Boolean).join(' · ')
        return (
          <View key={a.id}>
            {i > 0 && <Divider inset={60} />}
            <RowWithAction
              onPress={() => openAutomation(a.id)}
              accessibilityLabel={`${a.name}, ${sub}`}
              accessibilityHint="Opens the automation"
              action={<View style={{ paddingRight: 4 }}><Toggle value={a.enabled} onChange={(v) => onToggle(a, v)} accessibilityLabel={`${a.name} on`} /></View>}
            >
              <AutomationGlyph a={a} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text variant="bodyMedium" numberOfLines={1} color={a.enabled ? 'ink' : 'ink3'} style={{ flexShrink: 1 }}>{a.name}</Text>
                  <RunDots recent={a.recent ?? []} />
                </View>
                <Text variant="caption" color="ink3" numberOfLines={2}>{sub}</Text>
              </View>
            </RowWithAction>
          </View>
        )
      })}
    </Surface>
  )
}
