// CSV parsing + mapping for bank imports. Pure functions — no DB access here.

// RFC-4180-ish parser: quoted fields, embedded commas/quotes, \r\n line endings.
export function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  // Drop fully-empty rows and trailing empty columns (some exports carry a trailing comma)
  return rows
    .map(r => { while (r.length && r[r.length - 1].trim() === '') r.pop(); return r })
    .filter(r => r.length > 0)
}

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/ // dd/mm/yyyy

export function parseDate(s) {
  const m = DATE_RE.exec((s || '').trim())
  if (!m) return null
  const [, d, mo, y] = m
  const day = +d, month = +mo
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// "-174.90", "1,234.56", '"-174.90"' → signed integer cents
export function parseAmount(s) {
  const t = (s || '').replace(/[",$\s]/g, '')
  if (t === '' || !/^-?\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(parseFloat(t) * 100)
}

// A header row is one whose mapped-looking cells are not a date/amount.
export function detectHeader(rows) {
  if (!rows.length) return false
  return !rows[0].some(c => parseDate(c) !== null)
}

// mapping: { dateCol, payeeCol, amountCol } (signed single column)
//       or { dateCol, payeeCol, debitCol, creditCol } (separate columns)
// invertDebit: for credit cards, Debit → negative (money owed increases), Credit → positive.
// Both formats already store expenses negative, so no extra flag needed beyond debit negation.
export function mapRows(rows, mapping, hasHeader) {
  const data = hasHeader ? rows.slice(1) : rows
  return data.map((cells, i) => {
    const date = parseDate(cells[mapping.dateCol])
    const payee = (cells[mapping.payeeCol] || '').trim()
    let amount = null
    if (mapping.amountCol != null) {
      amount = parseAmount(cells[mapping.amountCol])
    } else {
      const debit = parseAmount(cells[mapping.debitCol])
      const credit = parseAmount(cells[mapping.creditCol])
      if (debit != null && debit !== 0) amount = -Math.abs(debit)
      else if (credit != null) amount = Math.abs(credit)
    }
    return { line: i + (hasHeader ? 2 : 1), date, payee, amount, valid: !!(date && amount != null && payee) }
  })
}

// Some banks put account-number fragments in transfer descriptions: 'FUNDS TFER ... TO 0139...' / '... FROM 1610...'
export function transferFragment(payee) {
  const m = /(?:TO|FROM)\s+(\d{6,})/i.exec(payee || '')
  return m ? m[1] : null
}
