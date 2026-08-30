import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { q, cleanup, backfillVendors } from './db.js'
import authRoutes from './routes/auth.js'
import setupRoutes from './routes/setup.js'
import accountRoutes from './routes/accounts.js'
import categoryRoutes from './routes/categories.js'
import transactionRoutes from './routes/transactions.js'
import importRoutes from './routes/imports.js'
import ruleRoutes from './routes/rules.js'
import recurringRoutes from './routes/recurring.js'
import alertRoutes from './routes/alerts.js'
import viewRoutes from './routes/views.js'
import aiRoutes from './routes/ai.js'
import settingsRoutes from './routes/settings.js'
import holdingRoutes from './routes/holdings.js'
import budgetRoutes from './routes/budgets.js'
import budgetAiRoutes from './routes/budget-ai.js'
import systemRoutes from './routes/system.js'

const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 })

// Sessions are signed with this — a known value means anyone can forge a login
// cookie. The dev fallback is convenient locally and unacceptable in production,
// so refuse to start rather than silently serve with a published secret.
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me'
if (process.env.NODE_ENV === 'production' && SESSION_SECRET === 'dev-secret-change-me') {
  throw new Error('SESSION_SECRET must be set in production — generate one with: openssl rand -hex 32')
}

await app.register(cookie, { secret: SESSION_SECRET })
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
// Binary uploads (release packages for /system/update)
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => done(null, body))

const PUBLIC = ['/api/health', '/api/auth/login', '/api/setup/status', '/api/setup/create-user']

app.addHook('preHandler', async (req, reply) => {
  if (PUBLIC.includes(req.url.split('?')[0])) return
  const raw = req.cookies.sid
  const unsigned = raw && req.unsignCookie(raw)
  if (!unsigned?.valid) return reply.code(401).send({ error: 'unauthenticated' })
  const r = await q('SELECT s.id, s.user_id FROM sessions s WHERE s.id = $1', [unsigned.value])
  if (!r.rows[0]) return reply.code(401).send({ error: 'unauthenticated' })
  req.session = r.rows[0]
  q('UPDATE sessions SET last_active = now() WHERE id = $1', [unsigned.value]).catch(() => {})
})

app.get('/api/health', async (req, reply) => {
  try { await q('SELECT 1'); return { status: 'ok', db: true } }
  catch { return reply.code(503).send({ status: 'degraded', db: false }) }
})

for (const r of [authRoutes, setupRoutes, accountRoutes, categoryRoutes, transactionRoutes,
  importRoutes, ruleRoutes, recurringRoutes, alertRoutes, viewRoutes, aiRoutes, settingsRoutes, holdingRoutes,
  budgetRoutes, budgetAiRoutes, systemRoutes]) {
  await app.register(r, { prefix: '/api' })
}

backfillVendors()
  .then(n => n && app.log.info(`backfilled vendor name on ${n} transactions`))
  .catch(err => app.log.error(err, 'vendor backfill failed'))
cleanup().catch(err => app.log.error(err, 'cleanup failed'))
setInterval(() => cleanup().catch(err => app.log.error(err, 'cleanup failed')), 24 * 60 * 60 * 1000).unref()

// localhost only — Nginx is the sole public entry point
await app.listen({ port: +(process.env.PORT || 3000), host: '127.0.0.1' })
