// Derive a readable merchant/vendor name from a raw bank statement description,
// e.g. "VISA DEBIT PURCHASE CARD 4321 FUEL DEPOT 0442 RIVERTON" → "Fuel Depot Riverton".
//
// This lives in the backend because the cleaned name is *stored* on each transaction
// (so the list can sort by it in SQL) and is served to the UI — one implementation,
// so the name you see and the order you get can never disagree.
// The stored payee always keeps the full original text, and search still matches it.

const PREFIXES = [
  /^VISA\s+(?:DEBIT|CREDIT)(?:\s+PURCHASE)?(?:\s+CARD)?(?:\s+X{0,4}\d{2,6})?\s+/i,
  /^(?:EFTPOS|POS AUTHORISATION|POS)\s+/i,
  /^ATM(?:\s+WITHDRAWAL)?\s+/i,
  /^PAYPAL\s*\*\s*/i,
  /^(?:SQ|SP|ZIP)\s*\*\s*/i,
  /^DIRECT\s+(?:DEBIT|CREDIT)(?:\s+(?:TO|FROM|RECEIVED))?\s+/i,
  /^BPAY(?:\s+PAYMENT)?(?:\s+TO)?\s+/i,
  /^PAY\/SALARY\s+FROM\s+/i,
  /^(?:ANZ|BOM|STG|WBC|NAB|CBA)?\s*(?:INTERNET|PHONE|MOBILE)\s+BANKING(?:\s+FUNDS)?(?:\s+(?:TFER|TRANSFER))*\s+/i,
  /^(?:TRANSFER|TFR|TFER|PAYMENT)\s+(?:TO|FROM)\s+/i,
]

const TRAILERS = [
  /\s+(?:AUS?|AUSTRALIA)$/i,
  /\s+(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)$/i,
  /\s+CARD\s+(?:X{0,4}\d+)$/i,
  /\s+(?:X{2,}\d*|\*+\d*|\d{3,})$/, // trailing store/card/reference numbers
  /\s+\d{2}\/\d{2}(?:\/\d{2,4})?$/, // trailing dates
]

const STOPWORDS = new Set(['of', 'to', 'at', 'on', 'in', 'by', 'for', 'and', 'the'])

function titleCase(s) {
  if (s !== s.toUpperCase()) return s // mixed case is already deliberate (e.g. iTunes)
  let first = true
  return s
    .toLowerCase()
    .replace(/[a-z']+/g, w => {
      const word = first ? false : STOPWORDS.has(w)
      first = false
      if (word) return w // connector words stay lowercase mid-name
      return w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)
    })
    .replace(/\.(Com|Net|Org|AU|Io)\b/g, m => m.toLowerCase())
}

function stripPrefixes(s) {
  for (let changed = true; changed;) {
    changed = false
    for (const re of PREFIXES) {
      const t = s.replace(re, '').trim()
      if (t !== s && t.length >= 3) { s = t; changed = true }
    }
  }
  return s
}

export function vendorFrom(payee) {
  const original = (payee || '').replace(/\s+/g, ' ').trim()
  let s = stripPrefixes(original)
  s = s
    .replace(/-[A-Z]{0,2}\d{5,}\b/gi, '') // reference suffixes: SOFTWARECO-G12345678
    .replace(/(^|\s)\d{2,}(?=\s|$)/g, ' ') // standalone store/reference numbers
    .replace(/\s+/g, ' ')
    .trim()
  for (let changed = true; changed;) {
    changed = false
    for (const re of TRAILERS) {
      const t = s.replace(re, '').trim()
      if (t !== s && t.length >= 3) { s = t; changed = true }
    }
  }
  // Drop a trailing domain-ish token when it's not the whole name: "SOFTWARECO BILLING.INFO"
  const words = s.split(' ')
  if (words.length > 1 && /\.[a-z]{2,}$/i.test(words[words.length - 1])) s = words.slice(0, -1).join(' ')
  // If cleaning left mostly digits (e.g. bare transfer references), keep the full details
  if ((s.match(/[a-z]/gi) || []).length < 3) s = original
  return titleCase(s) || payee
}

// A starting point for a categorisation rule's "payee contains" text. Must be a
// SUBSTRING of the raw payee (rules match the stored description), so this trims the
// bank's prefix and stops at the first reference number — unlike vendorFrom, which
// rewrites the text for display.
export function ruleSuggestion(payee) {
  let s = stripPrefixes((payee || '').replace(/\s+/g, ' ').trim())
  // Aggregators put the real merchant after a star: "DD *QUICKEATS CITYVILLE" → "QUICKEATS CITYVILLE"
  const star = s.match(/\*\s*([A-Za-z].*)$/)
  if (star) s = star[1]
  const words = []
  for (const w of s.split(' ')) {
    if (/\d/.test(w)) break            // store/reference numbers end the useful part
    words.push(w)
    if (words.length === 1 && w.length >= 6) break // a distinctive first word is enough
    if (words.length === 3) break
  }
  return words.join(' ') || s || payee
}
