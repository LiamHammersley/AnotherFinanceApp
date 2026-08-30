import { getSetting, setSetting, q } from '../db.js'
import { aiConfig } from '../services/ai.js'

export default async function (app) {
  app.get('/settings', async () => {
    const cfg = await aiConfig()
    return {
      aiEnabled: cfg.enabled,
      apiKeySet: !!cfg.apiKey,
      categorisationModel: cfg.categorisationModel,
      analysisModel: cfg.analysisModel,
      budgetModel: cfg.budgetModel,
      budgetEffort: cfg.budgetEffort,
      pageSize: +(await getSetting('page_size')) || 50,
    }
  })

  // Model changes take effect on the next request — no restart (spec 7.1).
  app.put('/settings', async (req) => {
    const b = req.body || {}
    if ('aiEnabled' in b) await setSetting('ai_enabled', String(!!b.aiEnabled))
    if (b.apiKey) await setSetting('anthropic_api_key', b.apiKey)
    if (b.categorisationModel) await setSetting('ai_model_categorisation', b.categorisationModel)
    if (b.analysisModel) await setSetting('ai_model_analysis', b.analysisModel)
    if (b.budgetModel) await setSetting('ai_model_budget', b.budgetModel)
    // How hard the planner thinks. Translated to whichever form the model takes.
    if (b.budgetEffort && ['off', 'low', 'medium', 'high'].includes(b.budgetEffort))
      await setSetting('ai_budget_effort', b.budgetEffort)
    if (b.pageSize) await setSetting('page_size', String(b.pageSize))
    return { ok: true }
  })
}
