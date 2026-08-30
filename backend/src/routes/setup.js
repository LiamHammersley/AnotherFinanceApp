import bcrypt from 'bcryptjs'
import { q, uuid, setSetting } from '../db.js'

export default async function (app) {
  app.get('/setup/status', async () => {
    const r = await q('SELECT count(*)::int AS n FROM users')
    return { needsSetup: r.rows[0].n === 0 }
  })

  // Step 1 of the wizard — only valid while no user exists
  app.post('/setup/create-user', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const existing = await q('SELECT count(*)::int AS n FROM users')
    if (existing.rows[0].n > 0) return reply.code(409).send({ error: 'Setup already completed' })
    const { username, password } = req.body || {}
    if (!username || !password || password.length < 10) return reply.code(400).send({ error: 'Username required; password must be at least 10 characters' })
    const id = uuid()
    await q('INSERT INTO users (id, username, password_hash) VALUES ($1,$2,$3)', [id, username, await bcrypt.hash(password, 12)])
    const sid = uuid()
    await q('INSERT INTO sessions (id, user_id, device_hint) VALUES ($1,$2,$3)', [sid, id, req.headers['user-agent']?.slice(0, 120) || 'setup'])
    reply.setCookie('sid', sid, { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', signed: true, maxAge: 60 * 60 * 24 * 365 })
    return { username }
  })

  // Step 2 — API key (skippable; AI stays disabled until a key exists)
  app.post('/setup/api-key', async (req) => {
    const { apiKey } = req.body || {}
    if (apiKey) await setSetting('anthropic_api_key', apiKey)
    return { ok: true }
  })
}
