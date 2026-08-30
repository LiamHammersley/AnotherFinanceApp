// Reset the login password from the host — the only way back in if it's forgotten,
// since there's no email on a single-user self-hosted install.
//   cd backend && npm run set-password -- <username> '<new password>'
import bcrypt from 'bcryptjs'
import { q, pool } from '../db.js'

const [username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error("Usage: npm run set-password -- <username> '<new password>'")
  process.exit(1)
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters.')
  process.exit(1)
}

const r = await q(
  'UPDATE users SET password_hash = $1, failed_attempts = 0, locked = FALSE WHERE username = $2 RETURNING id, username',
  [await bcrypt.hash(password, 12), username])

if (!r.rows[0]) {
  const known = await q('SELECT username FROM users')
  console.error(`No user named "${username}". Known users: ${known.rows.map(u => u.username).join(', ') || '(none)'}`)
  await pool.end()
  process.exit(1)
}

// Any stolen or stale session dies with the old password
const sessions = await q('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id])
console.log(`Password set for ${r.rows[0].username}; ${sessions.rowCount} session(s) signed out.`)
await pool.end()
