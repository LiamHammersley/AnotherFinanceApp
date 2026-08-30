import { q, uuid } from '../db.js'
import { aiConfig, callClaude, extractJson, estimateCostUsd, modelPrice } from '../services/ai.js'
import { loadRules, ruleEffects } from './rules.js'
import { matchRule } from '../services/rules.js'

async function categoryList() {
  const r = await q(`SELECT c.id, c.name, p.name AS parent FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE NOT c.archived ORDER BY p.name NULLS FIRST, c.name`)
  return r.rows
}

export default async function (app) {
  // Categorise uncategorised transactions. Rules first; only unmatched go to the AI, in batches of 25.
  app.post('/ai/categorise', async (req, reply) => {
    const cfg = await aiConfig()
    // suggestOnly: nothing auto-applies — every AI result becomes a suggestion the user confirms
    const suggestOnly = !!req.body?.suggestOnly
    const target = await q(`
      SELECT t.id, t.payee, t.account_id, t.amount_cents, t.type, t.notes FROM transactions t
      WHERE t.category_id IS NULL AND t.type IN ('income','expense') AND t.deleted_at IS NULL
      ${req.body?.importId ? 'AND t.import_id = $1' : ''} LIMIT 500`,
      req.body?.importId ? [req.body.importId] : [])
    let ruleAssigned = 0
    const forAi = []
    const rules = await loadRules()
    for (const t of target.rows) {
      const rule = matchRule(rules, t) // amount/account conditions need the whole row
      const fx = rule ? ruleEffects(rule) : null
      if (fx?.vendor) await q('UPDATE transactions SET vendor = $1, updated_at = now() WHERE id = $2', [fx.vendor, t.id])
      if (fx?.categoryId) {
        await q(`UPDATE transactions SET category_id = $1, assign_source = $2, updated_at = now() WHERE id = $3`,
          [fx.categoryId, fx.source, t.id])
        ruleAssigned++
      } else forAi.push(t)
    }
    if (!cfg.enabled || !cfg.apiKey) return { ruleAssigned, aiApplied: 0, aiSuggested: 0, low: 0, aiSkipped: true }

    const cats = await categoryList()
    const catText = cats.map(c => c.parent ? `${c.parent} > ${c.name} [${c.id}]` : `${c.name} [${c.id}]`).join('\n')
    const system = `You categorise personal finance transactions for an Australian household.
Given a JSON array of transactions, return ONLY a JSON array with one object per transaction:
{"id": "<transaction id>", "categoryId": "<category uuid from the list>", "confidence": <0-1>, "reasoning": "<brief>"}
Prefer sub-categories. Use the Uncategorised category only when nothing fits.
Available categories (name [uuid]):\n${catText}`

    let applied = 0, suggested = 0, low = 0
    for (let i = 0; i < forAi.length; i += 25) {
      const batch = forAi.slice(i, i + 25)
      const payload = batch.map(t => ({ id: t.id, payee: t.payee, amount: Number(t.amount_cents) / 100, type: t.type, ...(t.notes ? { notes: t.notes } : {}) }))
      let results
      try {
        results = extractJson(await callClaude('categorise', cfg.categorisationModel, cfg.apiKey, system, JSON.stringify(payload)))
      } catch (err) {
        req.log.error(err, 'AI categorisation batch failed')
        return reply.code(502).send({ error: 'AI request failed: ' + err.message, ruleAssigned, aiApplied: applied, aiSuggested: suggested, low })
      }
      const valid = new Set(cats.map(c => c.id))
      for (const s of results || []) {
        if (!batch.some(t => t.id === s.id) || !valid.has(s.categoryId)) continue
        if (!suggestOnly && s.confidence >= 0.85) {
          await q(`UPDATE transactions SET category_id=$1, assign_source='ai', ai_confidence=$2, updated_at=now() WHERE id=$3`,
            [s.categoryId, s.confidence, s.id])
          applied++
        } else if (s.confidence >= 0.5) {
          // Suggested but not applied: stored in notes-free suggestion columns would be over-modelling;
          // keep source+confidence so the UI can prompt for confirmation.
          await q(`UPDATE transactions SET assign_source='ai_suggested:'||$1, ai_confidence=$2, updated_at=now() WHERE id=$3`,
            [s.categoryId, s.confidence, s.id])
          suggested++
        } else low++
      }
    }
    const total = applied + suggested + low
    if (total > 0 && low / total > 0.2) {
      await q('INSERT INTO alerts (id, type, message, dedupe_key) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING',
        [uuid(), 'ai_confidence_low', `AI categorisation produced ${Math.round((low / total) * 100)}% low-confidence results.`, `lowconf:${Date.now()}`])
    }
    return { ruleAssigned, aiApplied: applied, aiSuggested: suggested, low }
  })

  // On-demand spending analysis — structured report, stateless.
  app.post('/ai/analysis', async (req, reply) => {
    const cfg = await aiConfig()
    if (!cfg.enabled || !cfg.apiKey) return reply.code(400).send({ error: 'AI is disabled or no API key is set' })
    const months = Math.min(Math.max(+req.body?.months || 3, 1), 24)
    const data = await q(`
      SELECT to_char(date_trunc('month', t.date), 'YYYY-MM') AS month,
             COALESCE(pc.name, c.name, 'Uncategorised') AS category, c.name AS sub_category,
             t.payee, SUM(t.amount_cents) AS cents, count(*) AS n
      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN categories pc ON pc.id = c.parent_id
      WHERE t.deleted_at IS NULL AND t.type IN ('income','expense','interest')
        AND t.date >= date_trunc('month', CURRENT_DATE) - ($1 || ' months')::interval
      GROUP BY 1,2,3,4 ORDER BY 1,2`, [months])
    const system = `You are a personal finance analyst for a single Australian household (amounts in AUD cents, expenses negative).
Return ONLY JSON in this exact shape:
{"totalAnnualSaving": <number, whole dollars/yr across all findings>,
 "summary": "<three sentences max: the biggest lever, what it is worth, what is realistically achievable>",
 "findings": [{
   "tag": "<one word, e.g. Food, Transport, Subscriptions, Utilities, Insurance, Anomaly>",
   "tone": "warm" | "alert" | "ai" | "neutral",
   "title": "<one line, under 70 characters, states the finding>",
   "now": "<current cost, e.g. ~$480/mo or $90 in July>",
   "annualSaving": <number, whole dollars per year>,
   "detail": "<2-3 sentences explaining it and what to do>",
   "evidence": ["<one datum per string, e.g. food delivery x9 in July>"],
   "action": "<short CTA label, e.g. Set a takeaway budget>",
   "search": "<payee text to filter the transaction list by, or empty string>"
 }]}
Rank findings by annualSaving, highest first. Aim for 6-8 findings covering: where to cut back
(delivery/takeaway, fuel-stop snacks, overlapping subscriptions, duplicate or unexpected charges)
and how to save more (cheaper providers or plans, consolidating services, re-quoting insurance,
right-sizing utility tiers, a realistic regular savings amount the numbers support).
Use "alert" tone for anomalies like double-billing. Be specific and grounded in the data given —
never invent transactions. At most 6 evidence chips per finding. Keep it brief enough to finish.`
    try {
      const result = extractJson(await callClaude('analysis', cfg.analysisModel, cfg.apiKey, system,
        `Aggregated transactions for the last ${months} months:\n${JSON.stringify(data.rows)}`))
      // Stable ids so a dismissal survives a reload
      if (Array.isArray(result.findings)) result.findings.forEach((f, i) => { f.id = f.id || `f${i}` })
      // Keep every report so older suggestions stay reviewable
      const id = uuid()
      await q('INSERT INTO ai_analyses (id, months, model, report) VALUES ($1,$2,$3,$4)',
        [id, months, cfg.analysisModel, JSON.stringify(result)])
      return { id, created_at: new Date().toISOString(), months, model: cfg.analysisModel, dismissed_findings: [], report: result }
    } catch (err) {
      req.log.error(err, 'AI analysis failed')
      return reply.code(502).send({ error: 'AI request failed: ' + err.message })
    }
  })

  // Past analysis reports, newest first (reports are small — return them whole)
  app.get('/ai/analyses', async () => {
    const r = await q('SELECT id, months, model, report, dismissed_findings, created_at FROM ai_analyses ORDER BY created_at DESC LIMIT 20')
    return r.rows
  })

  // The dashboard shows the most recent report on load, without re-running anything
  app.get('/ai/analysis/latest', async () => {
    const r = await q('SELECT id, months, model, report, dismissed_findings, created_at FROM ai_analyses ORDER BY created_at DESC LIMIT 1')
    return r.rows[0] ?? null
  })

  app.post('/ai/analyses/:id/dismiss', async (req, reply) => {
    const { findingId } = req.body || {}
    if (!findingId) return reply.code(400).send({ error: 'findingId required' })
    const r = await q(
      `UPDATE ai_analyses SET dismissed_findings = array_append(dismissed_findings, $1)
       WHERE id = $2 AND NOT ($1 = ANY(dismissed_findings)) RETURNING dismissed_findings`, [findingId, req.params.id])
    return { ok: true, dismissed: r.rows[0]?.dismissed_findings ?? [] }
  })

  // Natural language query: model returns a structured intent, backend runs a pre-written query. No model SQL.
  app.post('/ai/query', async (req, reply) => {
    const cfg = await aiConfig()
    if (!cfg.enabled || !cfg.apiKey) return reply.code(400).send({ error: 'AI is disabled or no API key is set' })
    const question = (req.body?.question || '').slice(0, 500)
    const cats = await categoryList()
    const system = `Convert a personal-finance question into a structured intent. Today is ${new Date().toLocaleDateString('en-CA')} (Australia).
Return ONLY JSON, one of:
{"intent":"category_total","categoryId":"<uuid>","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}
{"intent":"total","kind":"income"|"expense","from":"...","to":"..."}
{"intent":"top_categories","n":5,"from":"...","to":"..."}
{"intent":"largest_transactions","n":10,"from":"...","to":"..."}
{"intent":"payee_total","payee":"<text>","from":"...","to":"..."}
{"intent":"unsupported"}
Categories (name [uuid]):\n${cats.map(c => c.parent ? `${c.parent} > ${c.name} [${c.id}]` : `${c.name} [${c.id}]`).join('\n')}`
    let intent
    try { intent = extractJson(await callClaude('query', cfg.categorisationModel, cfg.apiKey, system, question)) }
    catch (err) { return reply.code(502).send({ error: 'AI request failed: ' + err.message }) }

    const live = "deleted_at IS NULL AND type IN ('income','expense','interest')"
    if (intent.intent === 'category_total' && cats.some(c => c.id === intent.categoryId)) {
      const r = await q(`SELECT COALESCE(SUM(t.amount_cents),0) AS cents, count(*)::int AS n FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${live.replaceAll('deleted_at', 't.deleted_at').replaceAll('type', 't.type')} AND (t.category_id = $1 OR c.parent_id = $1) AND t.date BETWEEN $2 AND $3`,
        [intent.categoryId, intent.from, intent.to])
      const txs = await q(`SELECT t.id, t.date, t.payee, t.vendor, t.amount_cents FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.deleted_at IS NULL AND (t.category_id = $1 OR c.parent_id = $1) AND t.date BETWEEN $2 AND $3 ORDER BY t.date DESC LIMIT 20`,
        [intent.categoryId, intent.from, intent.to])
      return { intent, answerCents: +r.rows[0].cents, count: r.rows[0].n, transactions: txs.rows }
    }
    if (intent.intent === 'total') {
      const cmp = intent.kind === 'income' ? '> 0' : '< 0'
      const r = await q(`SELECT COALESCE(SUM(amount_cents),0) AS cents, count(*)::int AS n FROM transactions WHERE ${live} AND amount_cents ${cmp} AND date BETWEEN $1 AND $2`, [intent.from, intent.to])
      return { intent, answerCents: +r.rows[0].cents, count: r.rows[0].n, transactions: [] }
    }
    if (intent.intent === 'top_categories') {
      const r = await q(`SELECT COALESCE(pc.name, c.name, 'Uncategorised') AS category, SUM(-t.amount_cents) AS cents
        FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories pc ON pc.id = c.parent_id
        WHERE t.deleted_at IS NULL AND t.type IN ('expense','interest') AND t.date BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 2 DESC LIMIT $3`, [intent.from, intent.to, Math.min(intent.n || 5, 20)])
      return { intent, rows: r.rows }
    }
    if (intent.intent === 'largest_transactions') {
      const r = await q(`SELECT id, date, payee, vendor, amount_cents FROM transactions WHERE ${live} AND date BETWEEN $1 AND $2 ORDER BY abs(amount_cents) DESC LIMIT $3`,
        [intent.from, intent.to, Math.min(intent.n || 10, 50)])
      return { intent, transactions: r.rows }
    }
    if (intent.intent === 'payee_total' && intent.payee) {
      const r = await q(`SELECT COALESCE(SUM(amount_cents),0) AS cents, count(*)::int AS n FROM transactions WHERE ${live} AND payee ILIKE '%'||$1||'%' AND date BETWEEN $2 AND $3`,
        [intent.payee, intent.from, intent.to])
      const txs = await q(`SELECT id, date, payee, vendor, amount_cents FROM transactions WHERE ${live} AND payee ILIKE '%'||$1||'%' AND date BETWEEN $2 AND $3 ORDER BY date DESC LIMIT 20`,
        [intent.payee, intent.from, intent.to])
      return { intent, answerCents: +r.rows[0].cents, count: r.rows[0].n, transactions: txs.rows }
    }
    return { intent: { intent: 'unsupported' }, error: "That question isn't supported yet — try asking about category or payee totals, top categories, or largest transactions." }
  })

  app.get('/ai/usage', async () => {
    const r = await q(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, request_type, model,
      count(*)::int AS calls, SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens
      FROM ai_usage GROUP BY 1,2,3 ORDER BY 1 DESC, 2`)
    // Priced per model — Opus costs ~5x Sonnet, so one flat rate was misleading
    return r.rows.map(row => ({
      ...row,
      est_cost_usd: +estimateCostUsd(row.model, row.input_tokens, row.output_tokens).toFixed(4),
      pricing_known: modelPrice(row.model).known,
    }))
  })
}
