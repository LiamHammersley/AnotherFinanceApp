// Interpreting the transaction search box. The same term is always matched against
// text; these parsers add amount and date matching when the term looks like one.

// Amount terms, all compared on the absolute value so they read the same for money
// in and money out:
//   124.53      exactly $124.53
//   124         any amount of $124 (i.e. $124.00–$124.99)
//   >500 <20    open-ended comparisons (also >=, <=)
//   100-200     an inclusive range
// Returns { min, max } in cents (either may be null), or null when the term isn't
// amount-like — in which case the caller just searches text.
export function parseAmountTerm(term) {
  const t = String(term || '').replace(/[$,\s]/g, '')
  if (!t) return null
  const cents = n => Math.round(Math.abs(parseFloat(n)) * 100)
  const NUM = String.raw`\d+(?:\.\d{1,2})?`

  const range = new RegExp(`^(${NUM})-(${NUM})$`).exec(t)
  if (range) {
    const [a, b] = [cents(range[1]), cents(range[2])]
    return { min: Math.min(a, b), max: Math.max(a, b) }
  }

  const cmp = new RegExp(`^(>=|<=|>|<)(${NUM})$`).exec(t)
  if (cmp) {
    const v = cents(cmp[2])
    // Inclusive either way: ">500" meaning "more than 500" vs "500 and up" is a
    // distinction nobody wants to think about while searching.
    return cmp[1].startsWith('>') ? { min: v, max: null } : { min: null, max: v }
  }

  // Explicit cents is an exact amount; a bare dollar figure covers that whole dollar
  const exact = new RegExp(`^-?${NUM}$`).exec(t)
  if (exact) {
    const v = cents(t)
    return /\./.test(t) ? { min: v, max: v } : { min: v, max: v + 99 }
  }
  return null
}

// dd/mm/yyyy (as displayed) or yyyy-mm-dd (as stored) → an ISO date string
export function parseDateTerm(term) {
  const t = String(term || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (!dmy) return null
  const [, d, m, y] = dmy
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null
  return `${y}-${String(+m).padStart(2, '0')}-${String(+d).padStart(2, '0')}`
}
