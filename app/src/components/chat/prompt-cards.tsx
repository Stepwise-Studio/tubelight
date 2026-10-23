import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import { router } from 'expo-router'
import { useState } from 'react'
import { TextInput, View } from 'react-native'
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated'
import { ArrowUp02Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { BrandTile } from '@/components/brand-mark'
import { ApiError, api } from '@/lib/api'
import { toolkitName } from '@/lib/catalog'
import type { Approval } from '@/lib/types'
import { motion, radius, type as typeScale, useTheme } from '@/theme'
import { Beam, Button, Icon, IconButton, Press, Squircle, Text, haptic, toast } from '@/ui'

type Decide = (body: { action: 'answer' | 'connected' | 'signed_in' | 'skip'; answer?: string }) => Promise<boolean>

function useDecide(approval: Approval, onDecided?: () => void): [Decide, string | null] {
  const [busy, setBusy] = useState<string | null>(null)
  const decide: Decide = async (body) => {
    setBusy(body.answer ?? body.action)
    try {
      await api(`/approvals/${approval.id}`, { method: 'POST', json: body })
      haptic.success()
      onDecided?.()
      return true
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Check your connection and try again.'
      toast({ title: body.action === 'connected' ? 'Not connected yet' : 'Unable to send', body: msg, tone: 'error' })
      return false
    } finally { setBusy(null) }
  }
  return [decide, busy]
}

/** A teammate's question: 2–4 options as rows, then "Something else" to type. Collapses to the pick once answered. */
export function QuestionCard({ approval, onDecided }: { approval: Approval; onDecided?: () => void }) {
  const { c, scheme } = useTheme()
  const [decide, busy] = useDecide(approval, onDecided)
  const [other, setOther] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const d = approval.draft as { question?: string; options?: string[]; allow_other?: boolean }
  const options = (d.options ?? []).slice(0, 4)
  const pending = approval.status === 'pending' && !picked
  const answer = picked ?? approval.answer

  const pick = async (value: string) => {
    haptic.tap()
    setPicked(value)
    if (!(await decide({ action: 'answer', answer: value }))) setPicked(null)
  }

  return (
    <Beam radius={radius.lg} active={pending}>
      <Squircle style={{ borderRadius: radius.lg, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 6 }}>
        <Text variant="bodyMedium" style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 }}>{d.question || 'Pick one'}</Text>
        <Animated.View layout={LinearTransition.duration(motion.duration.fast)} style={{ gap: 2 }}>
          {options.map((o, i) => {
            const chosen = answer === o
            return (
              <Press
                key={o}
                radius={radius.md}
                disabled={!pending || !!busy}
                onPress={() => pick(o)}
                accessibilityLabel={o}
                accessibilityState={{ selected: chosen, disabled: !pending }}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 10, paddingVertical: 8,
                  backgroundColor: chosen ? c.tubeSoft : 'transparent', opacity: !pending && !chosen ? 0.45 : 1,
                }}
              >
                <Squircle style={{ width: 22, height: 22, borderRadius: 7, backgroundColor: chosen ? c.tube : c.panel2, alignItems: 'center', justifyContent: 'center' }}>
                  {chosen ? <Icon icon={Tick02Icon} size={14} color={c.onTube} strokeWidth={2.2} /> : <Text variant="footnote" color="ink3" style={{ fontVariant: ['tabular-nums'] }}>{i + 1}</Text>}
                </Squircle>
                <Text style={{ flex: 1 }}>{o}</Text>
              </Press>
            )
          })}
          {pending && d.allow_other !== false && (
            <Squircle style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 4, borderRadius: radius.md, backgroundColor: c.panel2, paddingLeft: 12, paddingRight: 4, paddingVertical: 4 }}>
              <TextInput
                value={other}
                onChangeText={setOther}
                placeholder="Something else…"
                placeholderTextColor={c.ink4}
                selectionColor={c.tube}
                cursorColor={c.tube}
                keyboardAppearance={scheme}
                multiline
                accessibilityLabel="Type another answer"
                style={[typeScale.body, { flex: 1, color: c.ink, minHeight: 36, maxHeight: 120, paddingVertical: 7 }]}
              />
              <IconButton
                icon={ArrowUp02Icon}
                accessibilityLabel="Send answer"
                variant={other.trim() ? 'tube' : 'soft'}
                size={32}
                iconSize={16}
                disabled={!other.trim() || !!busy}
                onPress={() => pick(other.trim())}
              />
            </Squircle>
          )}
          {!pending && answer && !options.includes(answer) && (
            <Text variant="caption" color="ink2" style={{ paddingHorizontal: 10, paddingVertical: 6 }}>{`You said: ${answer}`}</Text>
          )}
        </Animated.View>
        {pending ? (
          <Press radius={radius.sm} static disabled={!!busy} onPress={() => decide({ action: 'skip' })} outerStyle={{ alignSelf: 'flex-end' }} style={{ paddingHorizontal: 10, minHeight: 36, justifyContent: 'center' }}>
            <Text variant="label" color="ink3">Skip</Text>
          </Press>
        ) : approval.status === 'rejected' ? (
          <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 10, paddingVertical: 6 }}>Skipped</Text>
        ) : null}
      </Squircle>
    </Beam>
  )
}

/** A teammate needs an app it can't reach yet: connect it right here, then the teammate carries on. */
export function ConnectCard({ approval, onDecided }: { approval: Approval; onDecided?: () => void }) {
  const { c } = useTheme()
  const [decide, busy] = useDecide(approval, onDecided)
  const [linking, setLinking] = useState(false)
  const d = approval.draft as { toolkit?: string; name?: string; reason?: string }
  const toolkit = d.toolkit ?? ''
  const name = d.name || toolkitName(toolkit)
  const pending = approval.status === 'pending'

  const connect = async () => {
    haptic.tap()
    setLinking(true)
    try {
      const callback = Linking.createURL('connections')
      const { redirect_url } = await api<{ redirect_url: string }>(`/connections/${toolkit}`, { method: 'POST', json: { callback_url: callback } })
      await WebBrowser.openAuthSessionAsync(redirect_url, callback)
      await decide({ action: 'connected' })
    } catch (e) {
      toast({ title: `Unable to connect ${name}`, body: (e as Error).message, tone: 'error' })
    } finally { setLinking(false) }
  }

  return (
    <Beam radius={radius.lg} active={pending}>
      <Squircle style={{ borderRadius: radius.lg, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 14, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <BrandTile toolkit={toolkit} size={40} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="bodyMedium" numberOfLines={1}>{pending ? `Connect ${name}` : name}</Text>
            <Text variant="caption" color="ink3" numberOfLines={3}>
              {pending ? d.reason || `Needed to finish this task. You sign in with ${name}; Tubelight never sees your password.` : approval.status === 'approved' ? 'Connected' : 'Skipped for now'}
            </Text>
          </View>
          {approval.status === 'approved' && (
            <Animated.View entering={FadeIn.duration(motion.duration.fast)}><Icon icon={Tick02Icon} size={20} color="success" strokeWidth={2} /></Animated.View>
          )}
        </View>
        {pending && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={`Connect ${name}`} loading={linking} disabled={!!busy} onPress={connect} style={{ flex: 1 }} />
            <Button label="Not now" variant="ghost" disabled={linking || !!busy} onPress={() => decide({ action: 'skip' })} />
          </View>
        )}
      </Squircle>
    </Beam>
  )
}

// Sites whose logos the app already knows (as connectable apps); anything else gets its letter.
const SITE_LOGO: Record<string, string> = {
  'x.com': 'twitter', 'twitter.com': 'twitter', 'linkedin.com': 'linkedin', 'instagram.com': 'instagram', 'facebook.com': 'facebook',
  'github.com': 'github', 'reddit.com': 'reddit', 'youtube.com': 'youtube', 'threads.net': 'threads',
}

/**
 * A teammate needs them signed in to a site in Tubelight's browser (agent-service browser_signin). Sign in opens the
 * site's sign-in page there with them in control; they type on the page itself, so no teammate (and no chat) ever
 * holds the password. Done on that screen marks this card signed in and the teammate carries on.
 */
export function SigninCard({ approval, onDecided }: { approval: Approval; onDecided?: () => void }) {
  const { c } = useTheme()
  const [decide, busy] = useDecide(approval, onDecided)
  const d = approval.draft as { site?: string; reason?: string; tab?: string; teammate?: string }
  const site = d.site ?? ''
  const pending = approval.status === 'pending'
  const who = d.teammate || 'Your teammate'

  return (
    <Beam radius={radius.lg} active={pending}>
      <Squircle style={{ borderRadius: radius.lg, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 14, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <BrandTile toolkit={SITE_LOGO[site] ?? site.split('.')[0]} size={40} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="bodyMedium" numberOfLines={1}>{pending ? `Sign in to ${site}` : site}</Text>
            <Text variant="caption" color="ink3" numberOfLines={3}>
              {pending ? `You sign in on the page yourself, in Tubelight’s browser. ${who} never sees your password.`
                : approval.status === 'approved' ? 'Signed in' : 'Skipped for now'}
            </Text>
          </View>
          {approval.status === 'approved' && (
            <Animated.View entering={FadeIn.duration(motion.duration.fast)}><Icon icon={Tick02Icon} size={20} color="success" strokeWidth={2} /></Animated.View>
          )}
        </View>
        {pending && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Sign in" disabled={!!busy} style={{ flex: 1 }}
              onPress={() => { haptic.tap(); router.push({ pathname: '/browser', params: { signin: approval.id, tab: d.tab ?? '', site } }) }} />
            <Button label="Not now" variant="ghost" disabled={!!busy} onPress={() => decide({ action: 'skip' })} />
          </View>
        )}
      </Squircle>
    </Beam>
  )
}
