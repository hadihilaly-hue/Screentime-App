// Minimal Supabase client over the REST + auth endpoints.
//
// Deliberately not @supabase/supabase-js: the extension has no build step, and
// everything needed here is four fetch calls.

import { CONFIG } from './config.js'

const SESSION_KEY = 'et_session'

export function isConfigured() {
  return (
    CONFIG.supabaseUrl &&
    CONFIG.supabaseAnonKey &&
    !CONFIG.supabaseUrl.includes('your-project-ref') &&
    !CONFIG.supabaseAnonKey.includes('your-anon')
  )
}

async function readStored() {
  const stored = await chrome.storage.local.get(SESSION_KEY)
  return stored[SESSION_KEY] ?? null
}

async function writeStored(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session })
}

function shape(payload) {
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    // expires_in is seconds from now; store an absolute ms timestamp.
    expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
    email: payload.user?.email ?? null,
    user_id: payload.user?.id ?? null,
  }
}

async function tokenRequest(grantType, body) {
  const res = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: {
      apikey: CONFIG.supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  if (!res.ok) {
    throw new Error(payload.error_description || payload.msg || payload.error || 'Sign in failed.')
  }
  return shape(payload)
}

export async function signIn(email, password) {
  const session = await tokenRequest('password', { email, password })
  await writeStored(session)
  return session
}

export async function signOut() {
  await chrome.storage.local.remove(SESSION_KEY)
}

export async function getSession() {
  return readStored()
}

/** Returns a valid access token, refreshing if it is close to expiry. */
async function accessToken() {
  const session = await readStored()
  if (!session) return null
  if (session.expires_at - 60_000 > Date.now()) return session.access_token

  try {
    const refreshed = await tokenRequest('refresh_token', { refresh_token: session.refresh_token })
    await writeStored(refreshed)
    return refreshed.access_token
  } catch {
    // Refresh token rejected — treat as signed out rather than retrying forever.
    await signOut()
    return null
  }
}

/**
 * GET against PostgREST as the signed-in user. Returns null when signed out, so
 * callers can distinguish "no session" from "no rows".
 */
export async function query(path) {
  if (!isConfigured()) throw new Error('Extension is not configured — see config.js.')
  const token = await accessToken()
  if (!token) return null

  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: CONFIG.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
    },
  })
  if (!res.ok) throw new Error(`Supabase returned ${res.status}`)
  return res.json()
}

/** Local wall-clock date as YYYY-MM-DD, matching the web app's todayISO(). */
export function todayISO() {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}
