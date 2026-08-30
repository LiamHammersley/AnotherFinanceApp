// Extended thinking is expressed two different ways depending on the model: a
// token budget (`thinking.type: enabled`) or an adaptive mode plus an effort level
// (`thinking.type: adaptive` + `output_config.effort`). Sending the wrong one is a
// hard 400, which is exactly what Fable 5 returned in production. These tests run
// against a local stand-in for the API, so the negotiation is proven without tokens.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const attempts = []
let accepts = 'adaptive'

const server = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    const b = JSON.parse(body)
    const style = b.thinking?.type ?? 'none'
    attempts.push({ style, effort: b.output_config?.effort, budget: b.thinking?.budget_tokens, max: b.max_tokens, temp: b.temperature })
    if (style !== 'none' && style !== accepts) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { type: 'invalid_request_error',
        message: `"thinking.type.${style}" is not supported for this model. Use "thinking.type.${accepts}" and "output_config.effort" to control thinking behavior.` } }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
    }))
  })
})

await new Promise(r => server.listen(4655, r))
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4655'
const { callClaude, extractJson } = await import('../src/services/ai.js')

const run = async (model, effort) => {
  attempts.length = 0
  const text = await callClaude('budget', model, 'k', 'sys', 'user', { effort })
  return { result: extractJson(text), attempts: [...attempts] }
}

// A model that only takes the adaptive form. Fable is tried adaptive first, so
// this is one call, with the effort passed straight through.
{
  accepts = 'adaptive'
  const { result, attempts: a } = await run('claude-fable-5', 'high')
  assert.deepEqual(result, { ok: true })
  assert.equal(a.length, 1, 'no retry needed')
  assert.equal(a[0].style, 'adaptive')
  assert.equal(a[0].effort, 'high')
  assert.equal(a[0].temp, undefined, 'temperature must stay unset alongside thinking')
}

// A model that only takes the token-budget form, tried adaptive first: the API
// says which form it wants and the call is retried rather than failing.
{
  accepts = 'enabled'
  const { result, attempts: a } = await run('claude-fable-5', 'high')
  assert.deepEqual(result, { ok: true }, 'recovered without the caller noticing')
  assert.equal(a.length, 2, 'one rejected attempt, one that worked')
  assert.equal(a[0].style, 'adaptive')
  assert.equal(a[1].style, 'enabled')
  assert.equal(a[1].budget, 20000, 'high effort maps to a large budget')
  assert.ok(a[1].max > a[1].budget, 'max_tokens must leave room for the answer')
}

// And the same negotiation in the other direction
{
  accepts = 'adaptive'
  const { result, attempts: a } = await run('claude-haiku-4-5-20251001', 'medium')
  assert.deepEqual(result, { ok: true })
  assert.equal(a.length, 2)
  assert.equal(a[0].style, 'enabled')
  assert.equal(a[0].budget, 10000, 'medium effort')
  assert.equal(a[1].style, 'adaptive')
  assert.equal(a[1].effort, 'medium')
}

// Effort 'off' sends no thinking at all, so there is nothing to negotiate
{
  accepts = 'enabled'
  const { attempts: a } = await run('claude-fable-5', 'off')
  assert.equal(a.length, 1)
  assert.equal(a[0].style, 'none')
  assert.equal(a[0].budget, undefined)
}

// A 400 that isn't about thinking is surfaced, not retried into a second charge
{
  accepts = 'adaptive'
  const stubborn = createServer((req, res) => {
    req.on('data', () => {}); req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'credit balance is too low' } }))
    })
  })
  await new Promise(r => stubborn.listen(4656, r))
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4656'
  const { callClaude: call2 } = await import('../src/services/ai.js?fresh=1')
  await assert.rejects(() => call2('budget', 'claude-fable-5', 'k', 's', 'u', { effort: 'high' }),
    /credit balance is too low/)
  stubborn.close()
}

server.close()
console.log('ai-thinking.test.js: all assertions passed')
