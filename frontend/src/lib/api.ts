async function req(path: string, opts: RequestInit = {}) {
  const res = await fetch('/api' + path, {
    // content-type only when a body exists — Fastify 400s on an empty JSON body
    ...(opts.body != null ? { headers: { 'content-type': 'application/json' } } : {}),
    credentials: 'same-origin',
    ...opts,
  })
  if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/setup')) {
    window.location.href = '/login'
    throw new Error('unauthenticated')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || res.statusText)
  }
  return res.json()
}

export const get = (p: string) => req(p)

// Binary upload (e.g. release packages) — bypasses the JSON body handling above
export async function upload(path: string, file: Blob) {
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    credentials: 'same-origin',
    body: file,
  })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('unauthenticated')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || res.statusText)
  }
  return res.json()
}
export const post = (p: string, body?: unknown) => req(p, { method: 'POST', body: JSON.stringify(body ?? {}) })
export const patch = (p: string, body?: unknown) => req(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) })
export const put = (p: string, body?: unknown) => req(p, { method: 'PUT', body: JSON.stringify(body ?? {}) })
export const del = (p: string) => req(p, { method: 'DELETE' })
