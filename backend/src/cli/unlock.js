// Unlock a locked account after failed-login lockout. Run on the host:
//   cd backend && npm run unlock -- <username>
import { q, pool } from '../db.js'

const username = process.argv[2]
if (!username) { console.error('Usage: npm run unlock -- <username>'); process.exit(1) }
const r = await q('UPDATE users SET locked = FALSE, failed_attempts = 0 WHERE username = $1 RETURNING username', [username])
console.log(r.rows[0] ? `Unlocked ${r.rows[0].username}` : `No user named ${username}`)
await pool.end()
