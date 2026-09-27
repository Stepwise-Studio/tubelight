import { Redirect } from 'expo-router'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Add01Icon, Delete02Icon, Edit02Icon, Mail01Icon, Search01Icon, Settings01Icon } from '@hugeicons/core-free-icons'

import { ScreenHeader } from '@/components/screen-header'
import { useTheme, type ThemePreference } from '@/theme'
import {
  AvatarStack, Badge, Beam, Button, Checkbox, Chip, Collapse, EmptyState, IconButton, ListRow, Markdown, NumberPop,
  Reveal, SearchField, SectionHeader, Segment, Sheet, Skeleton, SuccessCheck, Surface, TeammateAvatar, Text,
  TextField, ThinkingIndicator, Toggle, confirm, showMenu, toast,
} from '@/ui'

const team = [
  { id: '1', name: 'Dev', avatar_shape: 'mech' as const, color: '#8b9cf7' },
  { id: '2', name: 'Tess', avatar_shape: 'droid' as const, color: '#f7b58b' },
  { id: '3', name: 'Sol', avatar_shape: 'flower' as const, color: '#f78bc4' },
  { id: '4', name: 'Ivy', avatar_shape: 'cloud' as const, color: '#8bf7c9' },
]
const states = [
  { state: 'thinking', label: 'Thinking' }, { state: 'tool', label: 'Searching inbox' },
  { state: 'tool', label: 'Handing off to Tess' }, { state: 'writing', label: 'Writing' }, { state: 'waiting', label: 'Waiting for your approval' },
] as const

/** Dev-only gallery of every src/ui primitive, both themes. Open /ui-gallery. */
export default function UiGallery() {
  if (!__DEV__) return <Redirect href="/" />
  return <Gallery />
}

function Gallery() {
  const { preference, setPreference } = useTheme()
  const [q, setQ] = useState('')
  const [on, setOn] = useState(true)
  const [chk, setChk] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [n, setN] = useState(3)
  const [ready, setReady] = useState(false)
  const [open, setOpen] = useState(false)
  const [si, setSi] = useState(0)
  const [note, setNote] = useState('')
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="UI gallery" />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 80 }}>
        <Segment<ThemePreference> value={preference} onChange={setPreference} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        <Text variant="largeTitle">Large title</Text>
        <Text variant="title">Title 28</Text>
        <Text variant="heading">Heading 20</Text>
        <Text variant="headline">Headline 17</Text>
        <Text>Body 15. The quick brown fox jumps over the lazy dog.</Text>
        <Text variant="caption" color="ink3">Caption 13, ink3</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button label="Approve and send" haptic="success" onPress={() => toast({ title: 'Email sent', tone: 'success' })} />
          <Button label="Edit" variant="soft" icon={Edit02Icon} />
          <Button label="Outline" variant="outline" />
          <Button label="Ghost" variant="ghost" />
          <Button label="Reject" variant="destructive" onPress={async () => { if (await confirm({ title: 'Delete Dev?', body: 'Dev’s memory and DMs go too.', confirmLabel: 'Delete teammate', destructive: true })) toast({ title: 'Deleted' }) }} />
          <Button label="Loading" loading />
          <Button label="Small" size="sm" icon={Add01Icon} />
          <Button label="Disabled" disabled />
        </View>
        <Button label="Full width large" size="lg" fullWidth icon={Mail01Icon} iconPosition="right" />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <IconButton icon={Settings01Icon} accessibilityLabel="Settings" />
          <IconButton icon={Add01Icon} accessibilityLabel="Add" variant="soft" />
          <IconButton icon={Search01Icon} accessibilityLabel="Search" variant="solid" onPress={() => showMenu({ title: 'Message', message: 'Today at 09:41', items: [{ label: 'Copy text', icon: Edit02Icon, onPress: () => {} }, { label: 'Delete', icon: Delete02Icon, destructive: true, onPress: () => {} }] })} />
          <View>
            <IconButton icon={Mail01Icon} accessibilityLabel="Count" variant="soft" onPress={() => setN((x) => (x + 7) % 120)} />
            <View style={{ position: 'absolute', top: 2, right: 0 }}><Badge count={n} /></View>
          </View>
          <NumberPop value={n} variant="heading" />
          <SuccessCheck key={n} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Chip label="Idle" /><Chip label="Live" color="info" dot /><Chip label="Approved" color="success" variant="soft" />
          <Chip label="Expired" color="warning" variant="soft" /><Chip label="Failed" color="danger" variant="solid" /><Chip label="Magic" color="magical" variant="soft" />
          <Chip label="Small" size="sm" color="success" dot /><Chip label="Filter" selected onPress={() => {}} />
        </View>
        <SearchField value={q} onChangeText={setQ} placeholder="Search chats" />
        <TextField label="Email" placeholder="name@example.com" error={err} hint="We never email you." />
        <Button label="Trigger error" variant="soft" size="sm" onPress={() => setErr(err ? null : 'Enter a valid email address, like name@example.com.')} />
        <TextField label="Password" secureTextEntry value="hunter22" />
        <TextField label="Post" multiline showCount maxLength={280} value={note} onChangeText={setNote} placeholder="What should Sol post?" />
        <Toggle label="Send read receipts" description="Teammates see when you've read their messages." value={on} onChange={setOn} />
        <Checkbox label="Allow GitHub" value={chk} onChange={setChk} />
        <Surface padding={8}>
          <ListRow title="Dev" subtitle="Senior engineer" leading={<TeammateAvatar teammate={team[0]} size={40} interactive={false} />} chevron onPress={() => {}} />
          <ListRow title="Stepwise UI" subtitle="Dev: Pushed the fix to main" leading={<AvatarStack teammates={team} size={26} />} accessory={<Text variant="footnote" color="ink3" tabular>09:41</Text>} onPress={() => {}} />
          <ListRow title="Sign out" icon={Settings01Icon} destructive onPress={() => {}} />
        </Surface>
        <SectionHeader title="Avatars" />
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
          {team.map((t, i) => <TeammateAvatar key={t.id} teammate={t} size={48} state={i === 1 ? 'working' : i === 3 ? 'sleeping' : 'default'} />)}
        </View>
        <Surface padding={16} style={{ gap: 12 }}>
          <ThinkingIndicator state={states[si].state} label={states[si].label} />
          <Button label="Next status" size="sm" variant="soft" onPress={() => setSi((s) => (s + 1) % states.length)} />
        </Surface>
        <Beam radius={16}><Surface padding={16}><Text>Beam around a live composer</Text></Surface></Beam>
        <Surface padding={16}>
          <Reveal ready={ready} skeleton={<View style={{ gap: 8 }}><Skeleton width="60%" /><Skeleton width="90%" /><Skeleton width="40%" /></View>}>
            <Text>Loaded content replaces the skeleton in the same box.</Text>
          </Reveal>
          <Button label={ready ? 'Reset' : 'Load'} size="sm" variant="ghost" onPress={() => setReady(!ready)} />
        </Surface>
        <Surface padding={12}>
          <ListRow title="Tool calls" subtitle="2 calls" onPress={() => setOpen(!open)} />
          <Collapse open={open}><Text variant="caption" color="ink2" style={{ padding: 12 }}>GITHUB_LIST_ISSUES · done{'\n'}GITHUB_CREATE_PR · waiting</Text></Collapse>
        </Surface>
        <Surface padding={16}>
          <Markdown value={'Here is the **fix**, see [the PR](https://github.com).\n\n- one\n- two\n\n```ts\nconst answer = 42 // a long line that should scroll horizontally in the code block\n```\n\nInline `code` too.'} />
        </Surface>
        <Button label="Open sheet" variant="outline" onPress={() => setSheet(true)} />
        <Button label="Queue toasts" variant="outline" onPress={() => { toast({ title: 'Copied' }); toast({ title: 'Unable to send', body: 'Check your connection.', tone: 'error' }) }} />
        <EmptyState title="No approvals waiting" body="When a teammate wants to send, post or push, it waits here for you." art={<TeammateAvatar teammate={team[3]} size={56} state="sleeping" />} action={<Button label="Open chats" variant="soft" />} />
      </ScrollView>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Reject this draft?">
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          <TextField label="Note for Sol (optional)" placeholder="Too salesy, keep it plain" multiline />
          <Button label="Reject draft" variant="destructive" fullWidth onPress={() => setSheet(false)} />
        </View>
      </Sheet>
    </View>
  )
}
