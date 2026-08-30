const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' })

export const money = (cents: number | string) => aud.format(Number(cents) / 100)

// Signed display amount: U+2212 minus (not a hyphen), + on credits
export const signedMoney = (cents: number | string) => {
  const n = Number(cents)
  return (n > 0 ? '+$' : '−$') + aud.format(Math.abs(n) / 100).replace('$', '')
}

// Whole dollars, no cents — for headline figures like "$5,170/yr"
export const dollars = (amount: number) =>
  '$' + Math.round(amount).toLocaleString('en-AU')

// Every date in the UI renders as zero-padded DD/MM/YYYY. Storage stays ISO
// (Postgres DATE / timestamptz); this is the only place the display form is decided.
export const date = (d: string) => {
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${day}/${m}/${y}`
}

// "Jul 2026" — full year, so an uppercased column header can't be misread as a day
export const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-')
  return new Date(+y, +m - 1, 1).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })
}

// Australian financial year: 1 Jul – 30 Jun
export function financialYear(offset = 0) {
  const now = new Date()
  const startYear = (now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1) + offset
  return { from: `${startYear}-07-01`, to: `${startYear + 1}-06-30`, label: `FY ${startYear}–${(startYear + 1) % 100}` }
}

// Local-timezone YYYY-MM-DD — toISOString() is UTC, which is yesterday's date
// in Australia until mid-morning
export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const isoToday = () => isoDate(new Date())

// For timestamptz values (UTC ISO strings): converted to local time, then the same
// DD/MM/YYYY form. Built from date parts because toLocaleDateString('en-AU') drops
// the leading zeros ("9/7/2026") and its short form shortens the year ("9/7/26").
export const dateLocal = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

export const dateTimeLocal = (iso: string) => {
  const d = new Date(iso)
  return `${dateLocal(iso)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// --- net worth formatting ----------------------------------------------------
// The old Net worth screen rendered a paid-off credit card as a red "-$0.00".
// Zero is not negative and it is not a warning: it renders unsigned and quiet.
export const isZeroCents = (cents: number | string) => Math.round(Number(cents)) === 0

// Deltas are whole dollars — cents on a movement are noise — and always carry an
// explicit sign so the colour is never the only thing distinguishing up from down.
export const signedDollars = (cents: number | string) => {
  // Round to dollars BEFORE choosing the sign. Deciding the sign first turns a
  // −4 cent delta into "−$0" — the same negative zero this is here to prevent.
  const dollars = Math.round(Number(cents) / 100)
  if (dollars === 0) return '$0'
  return `${dollars > 0 ? '+' : '−'}$${Math.abs(dollars).toLocaleString('en-AU')}`
}

export const wholeDollars = (cents: number | string) =>
  `$${Math.abs(Math.round(Number(cents) / 100)).toLocaleString('en-AU')}`

// Prose reads "4 Aug 2026"; the dd/mm/yyyy form belongs in dense tables
export const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
