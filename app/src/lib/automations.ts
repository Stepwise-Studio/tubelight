// Automations: standing instructions teammates carry out on their own (agent-service `automations.py`).
// Set up by chatting with a teammate (or from the Automations screen); managed on /automations and /automation/[id].
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'

import { api } from '@/lib/api'
import { whenLabel } from '@/lib/format'
import { capitalize, describeSchedule, parseCron } from '@/lib/schedule'
import { supabase } from '@/lib/supabase'
import { confirm, haptic, toast } from '@/ui'

export type RunOutcome = 'posted' | 'quiet' | 'approval' | 'working' | 'failed' | 'cancelled' | 'filtered' | 'limited'

export interface AutomationRun {
  at: string
  outcome: RunOutcome
  /** Ran after its time (the service was offline). */
  late?: boolean
  /** The start of what it posted. */
  preview: string
  message_id: string | null
}

export interface Automation {
  id: string
  name: string
  instructions: string
  kind: 'schedule' | 'app'
  /** The schedule or event in plain words ("every 3 hours", "when a mail from abc arrives"). */
  when: string
  enabled: boolean
  teammate_id: string
  /** The chat it posts in: dm:<teammate> or proj:<project>. */
  thread_id: string
  created_at: string
  cron: string | null
  tz: string | null
  /** App events: the Composio trigger, its app, its settings and the extra keyword filter. */
  trigger: string | null
  app: string | null
  settings: Record<string, unknown>
  keywords: string[]
  /** The apps its runs may use; null = every app the teammate may use. */
  toolkits: string[] | null
  /** The next three run times (schedules that are on). */
  upcoming: string[]
  /** What would stop it working, in words (a disconnected app, a teammate who left the project). */
  problems: string[]
  last_run: string | null
  next_run: string | null
  /** Only from GET /automations/:id: the last 20 runs, newest first. */
  runs?: AutomationRun[]
}

export const whenText = (a: Automation) =>
  capitalize(a.when || (a.cron ? describeSchedule(parseCron(a.cron)) : a.trigger ? `when ${eventName(a.trigger)}` : 'on its own'))

/** GMAIL_NEW_GMAIL_MESSAGE -> "a new Gmail message" style, good enough for a label. */
export const eventName = (slug: string) => slug.toLowerCase().replace(/_trigger$/, '').replace(/_/g, ' ')

export const timing = (a: Automation) =>
  !a.enabled ? 'Paused'
    : a.next_run ? `Next ${whenLabel(a.next_run)}`
      : a.last_run ? `Last ran ${whenLabel(a.last_run)}`
        : a.kind === 'app' ? 'Waiting for its event' : 'Not run yet'

export const openAutomation = (id: string) => router.push({ pathname: '/automation/[id]', params: { id } })

/** From an automation's reply in a chat: find which automation ran (its event carries the rule) and open it. */
export async function openAutomationOfRun(runId: string) {
  const { data } = await supabase.from('events').select('rule_id').eq('run_id', runId).not('rule_id', 'is', null).limit(1)
  const id = (data?.[0] as { rule_id: string } | undefined)?.rule_id
  if (id) openAutomation(id)
  else toast({ title: 'That automation was deleted' })
}

/** Every automation, reloaded whenever the screen comes into focus. */
export function useAutomations() {
  const [list, setList] = useState<Automation[] | null>(null)
  const load = useCallback(() => api<Automation[]>('/automations').then(setList, (e: Error) => {
    setList((l) => l ?? [])
    toast({ title: 'Unable to load automations', body: e.message, tone: 'error' })
  }), [])
  useFocusEffect(useCallback(() => { load() }, [load]))
  const toggle = async (a: Automation, enabled: boolean) => {
    setList((l) => l?.map((x) => (x.id === a.id ? { ...x, enabled } : x)) ?? l)
    await setEnabled(a, enabled)
    load() // next run and the server's truth either way
  }
  return { list, load, toggle }
}

export async function setEnabled(a: Automation, enabled: boolean): Promise<Automation | null> {
  haptic.tap()
  try {
    return await api<Automation>(`/automations/${a.id}`, { method: 'PATCH', json: { enabled } })
  } catch (e) {
    toast({ title: enabled ? 'Unable to turn it on' : 'Unable to pause it', body: (e as Error).message, tone: 'error' })
    return null
  }
}

export async function runNow(a: Automation) {
  haptic.tap()
  try {
    await api(`/automations/${a.id}/run`, { method: 'POST' })
    toast({ title: `Running ${a.name}`, body: 'The reply lands in its chat.' })
    return true
  } catch (e) {
    toast({ title: 'Unable to run it', body: (e as Error).message, tone: 'error' })
    return false
  }
}

/** Asks first. True once it's gone. */
export async function removeAutomation(a: Automation) {
  const ok = await confirm({
    title: 'Delete this automation?',
    body: `${a.name} stops running. Its past messages stay in the chat.`,
    confirmLabel: 'Delete',
    cancelLabel: 'Keep it',
    destructive: true,
  })
  if (!ok) return false
  try {
    await api(`/automations/${a.id}`, { method: 'DELETE' })
    haptic.success()
    toast({ title: 'Automation deleted' })
    return true
  } catch (e) {
    toast({ title: 'Unable to delete it', body: (e as Error).message, tone: 'error' })
    return false
  }
}

/** An app's events (GET /apps/:toolkit/events), to start an automation on. */
export interface AppEvent {
  slug: string
  name: string
  required: string[]
  /** setting -> its description */
  settings: Record<string, string>
  types: Record<string, string>
  defaults: Record<string, unknown>
}
