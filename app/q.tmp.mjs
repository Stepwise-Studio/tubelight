// usage: node q.mjs '<js body using sb, api>'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
const env = Object.fromEntries(fs.readFileSync('/home/akhil/tubelight/app/.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]))
const t = Object.fromEntries(fs.readFileSync('/home/akhil/tubelight/.env.test','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]))
const sb = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY)
const { data, error } = await sb.auth.signInWithPassword({ email: t.TEST_EMAIL, password: t.TEST_PASSWORD })
if (error) { console.log('auth fail', error.message); process.exit(1) }
const tok = data.session.access_token
const api = async (p, init={}) => { const r = await fetch('http://localhost:8787'+p, { ...init, headers: { Authorization: 'Bearer '+tok, 'Content-Type':'application/json' }, body: init.json ? JSON.stringify(init.json) : undefined }); return [r.status, await r.json().catch(()=>null)] }
const uid = data.user.id
const body = process.argv[2]
const fn = new Function('sb','api','uid', `return (async()=>{ ${body} })()`)
console.log(JSON.stringify(await fn(sb, api, uid), null, 1))
