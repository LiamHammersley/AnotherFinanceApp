// Catches the class of bug that shipped twice: a handler that references an
// identifier which doesn't exist. `node --check` only validates syntax, so
// `const AVG_MONTHS` never being declared passed every check and 500'd in production.
//
// No database is needed. Each handler is invoked with DATABASE_URL pointed at a
// closed port, so a healthy handler fails with a CONNECTION error — while a broken
// one fails with ReferenceError/TypeError before it ever reaches the database.
// Anything in the second category is a bug in the code, not the environment.
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none'
process.env.SESSION_SECRET = 'smoke-test-secret-smoke-test-secret'

const CODE_ERRORS = ['ReferenceError', 'TypeError', 'SyntaxError', 'RangeError']

// A stand-in for the slice of Fastify our route modules use
function collect() {
  const routes = []
  const record = method => (path, handler) => routes.push({ method, path, handler })
  return { app: { get: record('GET'), post: record('POST'), put: record('PUT'), patch: record('PATCH'), delete: record('DELETE') }, routes }
}

const reply = () => {
  const r = { statusCode: 200, body: undefined }
  r.code = c => { r.statusCode = c; return r }
  r.send = b => { r.body = b; return r }
  return r
}

// Query params chosen so validation passes and the handler runs its real body
const QUERY = { month: '2026-08', months: '3', payee: 'TEST', matchText: 'TEST', status: 'active', conditions: '[]' }
const PARAMS = { id: '11111111-1111-1111-1111-111111111111', categoryId: '11111111-1111-1111-1111-111111111111' }

const MODULES = [
  '../src/routes/budgets.js',
  '../src/routes/budget-ai.js',
  '../src/routes/views.js',
  '../src/routes/rules.js',
  '../src/routes/transactions.js',
  '../src/routes/recurring.js',
  '../src/routes/accounts.js',
  '../src/routes/categories.js',
]

let checked = 0
for (const path of MODULES) {
  const mod = await import(path)
  const { app, routes } = collect()
  await mod.default(app)
  assert.ok(routes.length > 0, `${path} registered no routes`)

  for (const r of routes.filter(x => x.method === 'GET')) {
    checked++
    try {
      await r.handler({ query: { ...QUERY }, params: { ...PARAMS }, body: {}, log: { error() {} } }, reply())
    } catch (err) {
      assert.ok(
        !CODE_ERRORS.includes(err.constructor?.name),
        `${r.method} ${r.path} threw ${err.constructor?.name}: ${err.message}\n` +
        '      This is a bug in the handler, not a missing database.')
    }
  }
}

assert.ok(checked >= 15, `expected to exercise a good number of handlers, got ${checked}`)
console.log(`routes-smoke.test.js: ${checked} GET handlers reached the database layer without a code error`)
