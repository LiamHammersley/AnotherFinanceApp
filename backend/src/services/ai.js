import { q, uuid, getSetting } from '../db.js'

// Settings override env; both swappable without a code change (spec 7.1).
export async function aiConfig() {
  const [key, cat, ana, bud, effort, thinkBudget, enabled] = await Promise.all([
    getSetting('anthropic_api_key'), getSetting('ai_model_categorisation'),
    getSetting('ai_model_analysis'), getSetting('ai_model_budget'),
    getSetting('ai_budget_effort'), getSetting('ai_budget_thinking_tokens'), getSetting('ai_enabled'),
  ])
  return {
    apiKey: key || process.env.ANTHROPIC_API_KEY || null,
    categorisationModel: cat || process.env.AI_MODEL_CATEGORISATION || 'claude-haiku-4-5-20251001',
    analysisModel: ana || process.env.AI_MODEL_ANALYSIS || 'claude-opus-5',
    // Budget planning reasons over goals, history and trade-offs at once, so it runs
    // on Fable 5 with extended thinking rather than the general analysis model.
    budgetModel: bud || process.env.AI_MODEL_BUDGET || 'claude-fable-5',
    // How hard the planner thinks, expressed once and translated per model — some
    // take a token budget, newer ones take an effort level. `0`/'off' disables it.
    // The old token setting is honoured so an existing install keeps its choice.
    budgetEffort: effort || (thinkBudget === '0' ? 'off' : null)
      || process.env.AI_BUDGET_EFFORT || 'high',
    enabled: enabled !== 'false',
  }
}

const MAX_TOKENS = { categorise: 4096, analysis: 16384, query: 1024, budget: 16384 }

// USD per million tokens [input, output], matched by longest model-id prefix.
// Anthropic bills in USD; check https://www.anthropic.com/pricing when models change.
const PRICING = [
  ['claude-opus-5', [5, 25]],
  ['claude-opus', [15, 75]],
  ['claude-sonnet', [3, 15]],
  ['claude-haiku-4-5', [1, 5]],
  ['claude-haiku', [0.8, 4]],
  ['claude-3-5-haiku', [0.8, 4]],
]
const DEFAULT_PRICE = [3, 15] // unknown model: assume mid-tier rather than free

export function modelPrice(model) {
  const hit = PRICING
    .filter(([prefix]) => (model || '').startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0]
  return { price: hit ? hit[1] : DEFAULT_PRICE, known: !!hit }
}

// Cost in USD for a given token split
export function estimateCostUsd(model, inputTokens, outputTokens) {
  const { price: [inPrice, outPrice] } = modelPrice(model)
  return ((inputTokens || 0) * inPrice + (outputTokens || 0) * outPrice) / 1e6
}
const TIMEOUT_MS = 120_000 // analysis can legitimately take a minute-plus at 8k max_tokens
// Overridable so the call can be pointed at a proxy — or a stub, to test the
// request/response handling without spending tokens.
const API_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
const THINKING_TIMEOUT_MS = 300_000 // a thinking model reasoning over a year of history is slower still

// Models express extended thinking two different ways, and which one a model wants
// is not something we can know ahead of time: older ones take an explicit token
// budget, newer ones (Fable 5) take an adaptive mode plus an effort level. We pick
// the likely shape, then retry with the other if the API says we guessed wrong —
// so a new model doesn't need a code change here.
const EFFORT_TOKENS = { low: 4000, medium: 10000, high: 20000 }

function withThinking(body, style, effort, requestType) {
  const next = { ...body }
  if (!effort || effort === 'off') return next
  if (style === 'adaptive') {
    next.thinking = { type: 'adaptive' }
    next.output_config = { effort }
  } else {
    const budget = EFFORT_TOKENS[effort] ?? EFFORT_TOKENS.high
    next.thinking = { type: 'enabled', budget_tokens: budget }
    next.max_tokens = Math.max(MAX_TOKENS[requestType] || 1024, budget + 6000)
  }
  return next
}

// Which shape to try first. Only a hint — the retry below is what makes it correct.
const preferredStyle = model => (/^claude-(fable|opus-5|sonnet-5)/.test(model || '') ? 'adaptive' : 'enabled')

// ponytail: plain fetch, no SDK dependency — the API surface we use is one endpoint.
// opts.effort turns on extended thinking; temperature must stay unset alongside it.
export async function callClaude(requestType, model, apiKey, system, userContent, opts = {}) {
  const base = {
    model,
    max_tokens: MAX_TOKENS[requestType] || 1024,
    system,
    messages: [{ role: 'user', content: userContent }],
  }
  const thinking = opts.effort && opts.effort !== 'off'
  const timeout = thinking ? THINKING_TIMEOUT_MS : TIMEOUT_MS

  const send = async (style) => {
    try {
      return await fetch(`${API_BASE}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify(withThinking(base, style, opts.effort, requestType)),
      })
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError')
        throw new Error(`Anthropic API timed out after ${timeout / 1000}s`)
      throw err
    }
  }

  let style = preferredStyle(model)
  let res = await send(style)
  if (!res.ok && thinking && res.status === 400) {
    const body = await res.text()
    // The API tells us which form it wants; take it at its word rather than
    // failing on a difference we can correct.
    if (/thinking\.type|output_config|budget_tokens|effort/i.test(body)) {
      style = style === 'adaptive' ? 'enabled' : 'adaptive'
      res = await send(style)
      // Both dialects refused: the model wants something neither shape provides.
      // Say so in terms of the setting the reader can actually change.
      if (!res.ok && res.status === 400) {
        const second = await res.text()
        throw new Error(`${model} rejected both thinking modes — set “Budget thinking” to off in Settings, `
          + `or pick a model that supports it. The API said: ${second.slice(0, 200)}`)
      }
    } else {
      throw new Error(`Anthropic API 400: ${body.slice(0, 300)}`)
    }
  }
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  // Usage logging is telemetry. Losing a response the user has already paid for
  // because the bookkeeping insert failed would be the worse outcome.
  try {
    await q('INSERT INTO ai_usage (id, request_type, model, input_tokens, output_tokens) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), requestType, model, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0])
  } catch { /* keep the answer */ }
  // A response cut off at max_tokens is unparseable half-JSON — name the real problem
  if (data.stop_reason === 'max_tokens')
    throw new Error(requestType === 'budget'
      ? 'The AI ran out of room before finishing the plan — lower the thinking tokens in Settings, or use less history'
      : 'The AI response was cut off at the length limit — try a shorter analysis period')
  // Newer models can prepend thinking blocks: join every text block, never assume content[0]
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
  if (!text.trim())
    throw new Error(`AI returned no text (content types: ${(data.content || []).map(b => b.type).join(', ') || 'none'})`)
  return text
}

// Models sometimes wrap JSON in prose/fences; extract the first JSON value.
// A model that answered in prose is a legible failure, not a stack trace.
export function extractJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/([[{][\s\S]*[\]}])/)
  try {
    return JSON.parse(m ? m[1] : text)
  } catch {
    throw new Error(`The AI replied in prose rather than the structured answer expected — try again. It said: “${text.trim().slice(0, 120)}…”`)
  }
}
