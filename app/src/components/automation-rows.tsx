import { View } from 'react-native'
import { WorkflowIcon } from '@hugeicons/core-free-icons'

import { RowWithAction } from '@/components/form-bits'
import { ago } from '@/lib/format'
import { openAutomation, timing, whenText, type Automation, type RunOutcome } from '@/lib/automations'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Divider, Icon, Surface, Text, Toggle } from '@/ui'

/** The icon tile an automation wears everywhere (a workflow); tinted while on. */
export function AutomationGlyph({ a, size = 36 }: { a: Pick<Automation, 'kind' | 'enabled'>; size?: number }) {
  const { c } = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: a.enabled ? c.tubeSoft : c.panel2, alignItems: 'center', justifyContent: 'center' }}>
      <Icon icon={WorkflowIcon} size={Math.round(size * 0.47)} color={a.enabled ? 'tube' : 'ink3'} />
    </View>
  )
}

/** How its latest run went, in words ("Last run posted · 2 h ago", "Failed the last 2 runs"); null before any run. */
export function lastRun(a: Automation): { text: string; bad: boolean } | null {
  const r = a.recent ?? []
  if (!r.length) return null
  const when = a.last_run ? ` · ${ago(a.last_run)}` : ''
  let fails = 0
  while (r[fails] === 'failed') fails++
  if (fails > 1) return { text: `Failed the last ${fails} runs`, bad: true }
  const words: Record<RunOutcome, string> = {
    posted: 'Last run posted', quiet: 'Last run: nothing new', failed: 'Last run failed', approval: 'Waiting for your OK',
    working: 'Running now', cancelled: 'Last run was stopped', filtered: 'Last event didn’t match', limited: 'Hit its hourly limit',
  }
  return { text: words[r[0]] + (r[0] === 'working' || r[0] === 'approval' ? '' : when), bad: r[0] === 'failed' }
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
        const last = lastRun(a)
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
                <Text variant="bodyMedium" numberOfLines={1} color={a.enabled ? 'ink' : 'ink3'}>{a.name}</Text>
                <Text variant="caption" color="ink3" numberOfLines={2}>{sub}</Text>
                {last && <Text variant="caption" color={last.bad ? 'danger' : 'ink2'} numberOfLines={1}>{last.text}</Text>}
              </View>
            </RowWithAction>
          </View>
        )
      })}
    </Surface>
  )
}
