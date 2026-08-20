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

  let payload = null
  try {
    payload = await res.json()
  } catch {
    // A captive portal or proxy answering with HTML. Not an auth decision.
    payload = null
  }

  if (!res.ok) {
    const error = new Error(
      payload?.error_description || payload?.msg || payload?.error || `Auth returned ${res.status}.`,
    )
    // Only a 4xx is the credential itself being refused. A 5xx, or anything
    // that did not parse as JSON, is the server or the network having a bad
    // moment — callers must be able to tell those apart before signing out.
    error.authRejected = res.status >= 400 && res.status < 500
    throw error
  }

  if (!payload?.access_token) throw new Error('Auth returned no access token.')
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
  } catch (e) {
    if (e?.authRejected) {
      // The refresh token really was refused. Signing out is correct.
      await signOut()
      return null
    }
    // Offline, 5xx, or a captive portal. Signing out here was how a brief
    // outage landing near token expiry produced a hard mid-session block that
    // the worker's grace window never saw — and it destroyed the stored
    // session, so it could not heal on the next poll either. Rethrow instead:
    // that is a failed check, which grace absorbs, and the session survives.
    throw e
  }
}

/** One PostgREST call as the signed-in user. Returns null when signed out. */
async function request(path, { method = 'GET', body, prefer } = {}) {
  if (!isConfigured()) throw new Error('Extension is not configured — see config.js.')
  const token = await accessToken()
  if (!token) return null

  const headers = {
    apikey: CONFIG.supabaseAnonKey,
    Authorization: `Bearer ${token}`,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (prefer) headers.Prefer = prefer

  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!res.ok) {
    // PostgREST puts the useful part in a JSON body — an RLS refusal and a
    // check-constraint violation are both 4xx and mean very different things.
    let detail = ''
    try {
      const payload = await res.json()
      detail = payload?.message || payload?.hint || ''
    } catch {
      detail = ''
    }
    throw new Error(detail ? `Supabase returned ${res.status}: ${detail}` : `Supabase returned ${res.status}`)
  }

  if (res.status === 204) return []
  return res.json()
}

/**
 * GET against PostgREST as the signed-in user. Returns null when signed out, so
 * callers can distinguish "no session" from "no rows".
 */
export async function query(path) {
  return request(path)
}

/**
 * INSERT, returning the created rows. Null when signed out.
 *
 * Writes are new in v0.4.0: the block page is now where sessions start (spec
 * section 3A), so the extension is no longer read-only. It still touches only
 * the two tables the web app already writes, under the same RLS policies —
 * there is no privilege here the app did not already have.
 */
export async function insert(path, row) {
  return request(path, { method: 'POST', body: row, prefer: 'return=representation' })
}

/** UPDATE, returning the affected rows so a zero-row RLS filter is visible. */
export async function patch(path, changes) {
  return request(path, { method: 'PATCH', body: changes, prefer: 'return=representation' })
}

/** Local wall-clock date as YYYY-MM-DD, matching the web app's todayISO(). */
export function todayISO() {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}
