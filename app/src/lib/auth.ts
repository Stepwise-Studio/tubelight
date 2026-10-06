// Google sign-in through Supabase (PKCE): Google's account chooser in a secure browser tab, back to tubelight://auth.
// `link` adds Google to the account you're signed in to, so your chats, teammates, memory, to-dos and vault come
// along whichever phone you sign in from.
import * as WebBrowser from 'expo-web-browser'

import { supabase } from '@/lib/supabase'

const redirectTo = 'tubelight://auth'

export async function google(link = false): Promise<boolean> {
  const { data, error } = link
    ? await supabase.auth.linkIdentity({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } })
    : await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } })
  if (error) throw new Error(friendly(error.message))
  if (!data?.url) throw new Error('Google sign-in isn’t set up yet.')
  const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo)
  if (res.type !== 'success') return false
  const url = new URL(res.url)
  const frag = new URLSearchParams(url.hash.slice(1))
  const failed = url.searchParams.get('error_description') ?? frag.get('error_description')
  if (failed) throw new Error(friendly(failed))
  const code = url.searchParams.get('code')
  if (code) {
    const { error: e } = await supabase.auth.exchangeCodeForSession(code)
    if (e) throw new Error(friendly(e.message))
    return true
  }
  return false
}

/** How you can sign in to this account (email, Google). */
export async function identities() {
  const { data } = await supabase.auth.getUserIdentities()
  return (data?.identities ?? []).map((i) => ({ provider: i.provider, email: (i.identity_data?.email as string | undefined) ?? null }))
}

function friendly(m: string) {
  const s = m.toLowerCase()
  if (s.includes('provider is not enabled') || s.includes('unsupported provider')) return 'Google sign-in isn’t switched on for Tubelight yet.'
  if (s.includes('manual linking')) return 'Linking another sign-in isn’t switched on for Tubelight yet.'
  if (s.includes('already linked') || s.includes('identity is already')) return 'That Google account already belongs to another Tubelight account.'
  return m
}
