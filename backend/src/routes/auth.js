import bcrypt from 'bcryptjs'
import { q, uuid } from '../db.js'

const COOKIE = { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', signed: true, maxAge: 60 * 60 * 24 * 365 }

export default async function (app) {
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { username, password } = req.body || {}
    const r = await q('SELECT * FROM users WHERE username = $1', [username])
    const user = r.rows[0]
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' })
    if (user.locked) return reply.code(423).send({ error: 'Account locked. Run `npm run unlock -- <username>` on the host to reset.' })
    if (!(await bcrypt.compare(password || '', user.password_hash))) {
      const attempts = user.failed_attempts + 1
      await q('UPDATE users SET failed_attempts = $1, locked = $2 WHERE id = $3', [attempts, attempts >= 10, user.id])
      return reply.code(401).send({ error: 'Invalid credentials' })
    }
    await q('UPDATE users SET failed_attempts = 0 WHERE id = $1', [user.id])
    const sid = uuid()
    await q('INSERT INTO sessions (id, user_id, device_hint) VALUES ($1,$2,$3)', [sid, user.id, req.headers['user-agent']?.slice(0, 120) || 'unknown'])
    reply.setCookie('sid', sid, COOKIE)
    return { username: user.username }
  })

  app.post('/auth/logout', async (req, reply) => {
    await q('DELETE FROM sessions WHERE id = $1', [req.session.id])
    reply.clearCookie('sid', { path: '/' })
    return { ok: true }
  })

  app.get('/auth/me', async (req) => {
    const r = await q('SELECT username FROM users WHERE id = $1', [req.session.user_id])
    return { username: r.rows[0]?.username }
  })

  app.get('/auth/sessions', async (req) => {
    const r = await q('SELECT id, device_hint, created_at, last_active FROM sessions WHERE user_id = $1 ORDER BY last_active DESC', [req.session.user_id])
    return r.rows.map(s => ({ ...s, current: s.id === req.session.id }))
  })

  app.post('/auth/sessions/revoke-all', async (req, reply) => {
    await q('DELETE FROM sessions WHERE user_id = $1', [req.session.user_id])
    reply.clearCookie('sid', { path: '/' })
    return { ok: true }
  })

  app.post('/auth/change-password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body || {}
    if (!newPassword || newPassword.length < 10) return reply.code(400).send({ error: 'Password must be at least 10 characters' })
    const r = await q('SELECT * FROM users WHERE id = $1', [req.session.user_id])
    if (!(await bcrypt.compare(currentPassword || '', r.rows[0].password_hash))) return reply.code(401).send({ error: 'Current password incorrect' })
    await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(newPassword, 12), req.session.user_id])
    await q('DELETE FROM sessions WHERE user_id = $1', [req.session.user_id]) // invalidate all sessions on password change
    reply.clearCookie('sid', { path: '/' })
    return { ok: true }
  })
}
