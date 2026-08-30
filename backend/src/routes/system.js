// In-app software updates: upload a release .tar.gz from Settings, no console needed.
// Runs entirely as the unprivileged service user: files in APP_DIR are ours, the
// web root is chown'd to us at install time, and the "restart" is process.exit —
// systemd's Restart=on-failure brings us back up and ExecStartPre runs migrations.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { q, uuid, audit } from '../db.js'

const run = promisify(execFile)
const APP_DIR = path.resolve(process.cwd(), '..') // cwd is backend/ (systemd WorkingDirectory + npm workspace)
const WEB_ROOT = process.env.WEB_ROOT || '/var/www/finance'
// node_modules is rebuilt, updates/ holds our own snapshots, .env never ships
const EXCLUDES = ['--exclude', 'node_modules', '--exclude', 'updates', '--exclude', '.env']

const readVersion = async (dir) => JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))

export default async function (app) {
  app.get('/system/version', async () => {
    const pkg = await readVersion(APP_DIR)
    return { version: pkg.version }
  })

  // Download a full database backup without touching the console. Streams
  // `pg_dump | gzip` so nothing large is buffered in memory.
  app.get('/system/backup', async (req, reply) => {
    const { spawn } = await import('node:child_process')
    const { createGzip } = await import('node:zlib')
    // Probe first: a missing binary should be a clean JSON error, not a corrupt download
    try {
      await run('pg_dump', ['--version'])
    } catch (err) {
      return reply.code(500).send({
        error: err.code === 'ENOENT'
          ? 'pg_dump was not found on the server. Install the postgresql client (it ships with postgresql-16) and try again.'
          : `pg_dump is not usable: ${err.message}`,
      })
    }

    const dump = spawn('pg_dump', ['--no-owner', '--no-acl', process.env.DATABASE_URL || 'finance'],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    // Pipe immediately — waiting for a readiness event loses the head of the stream
    const gzip = dump.stdout.pipe(createGzip())
    let stderr = ''
    dump.stderr.on('data', d => { stderr += d.toString().slice(0, 500) })
    dump.on('close', code => {
      if (code !== 0) req.log.error(`pg_dump exited ${code}: ${stderr.trim()}`)
    })

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    await audit('backup', 'system', null, null, { file: `finance-${stamp}.sql.gz` })
    reply.header('content-type', 'application/gzip')
    reply.header('content-disposition', `attachment; filename="finance-${stamp}.sql.gz"`)
    return reply.send(gzip)
  })

  app.post('/system/update', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 1024)
      return reply.code(400).send({ error: 'Attach a release .tar.gz as the request body (application/octet-stream)' })

    const updates = path.join(APP_DIR, 'updates')
    const staging = path.join(updates, 'staging')
    const previous = path.join(updates, 'previous')
    await fs.mkdir(updates, { recursive: true })
    const pkgFile = path.join(updates, `upload-${Date.now()}.tar.gz`)
    await fs.writeFile(pkgFile, req.body)

    // Unpack and validate before touching the live install
    await fs.rm(staging, { recursive: true, force: true })
    await fs.mkdir(staging, { recursive: true })
    let staged
    try {
      await run('tar', ['-xzf', pkgFile, '-C', staging, '--strip-components=1'])
      staged = await readVersion(staging)
    } catch {
      await fs.rm(pkgFile, { force: true })
      return reply.code(400).send({ error: 'Not a valid finance-app release package (.tar.gz built with `npm run package`)' })
    }
    if (staged.name !== 'finance-app' || !staged.version)
      return reply.code(400).send({ error: `Package is "${staged.name || 'unknown'}", expected a finance-app release` })
    if (!(await fs.stat(path.join(staging, 'backend/src/server.js')).catch(() => null)))
      return reply.code(400).send({ error: 'Package is missing backend/src/server.js — not a complete release' })
    const current = (await readVersion(APP_DIR)).version

    // Snapshot the running version (manual rollback: re-upload an older package,
    // or on the console: rsync updates/previous/ back over the app dir)
    await run('rsync', ['-a', '--delete', ...EXCLUDES, APP_DIR + '/', previous + '/'])
    try {
      await run('rsync', ['-a', '--delete', ...EXCLUDES, staging + '/', APP_DIR + '/'])
      await run('npm', ['ci', '--workspace', 'backend', '--omit=dev'], { cwd: APP_DIR, timeout: 300_000 })
    } catch (e) {
      req.log.error(e, 'update failed — restoring previous version')
      await run('rsync', ['-a', '--delete', ...EXCLUDES, previous + '/', APP_DIR + '/']).catch(() => {})
      await run('npm', ['ci', '--workspace', 'backend', '--omit=dev'], { cwd: APP_DIR, timeout: 300_000 }).catch(() => {})
      return reply.code(500).send({ error: 'Install failed — previous version restored. ' + (e.stderr?.slice(0, 300) || e.message) })
    }

    let warning = null
    try {
      await run('rsync', ['-a', '--delete', path.join(APP_DIR, 'frontend/dist') + '/', WEB_ROOT + '/'])
    } catch {
      warning = `Web root ${WEB_ROOT} is not writable by the service — backend updated, frontend unchanged. Fix once on the console: chown -R finance:finance ${WEB_ROOT}`
    }

    await audit('update', 'system', null, { version: current }, { version: staged.version })
    await q('INSERT INTO alerts (id, type, message, dedupe_key) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING',
      [uuid(), 'update_applied', `Software updated ${current} → ${staged.version}.`, `update:${current}->${staged.version}:${Date.now()}`])

    // Keep only the five most recent uploaded packages
    const old = (await fs.readdir(updates)).filter(f => f.startsWith('upload-')).sort().slice(0, -5)
    for (const f of old) await fs.rm(path.join(updates, f), { force: true })

    reply.send({ ok: true, from: current, to: staged.version, warning, restarting: true })
    // Exit after the response flushes; systemd restarts us on the new code and runs migrations
    setTimeout(() => process.exit(1), 800)
  })
}
