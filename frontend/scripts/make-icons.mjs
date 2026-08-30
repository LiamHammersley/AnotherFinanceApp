// Generates the PWA icons in frontend/public/ — brand-blue tile with white
// ascending bars. Pure Node (zlib), no image dependencies. Re-run after any
// design change: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public')
mkdirSync(OUT, { recursive: true })

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

const BG = [0x25, 0x63, 0xeb] // --color-brand
const BARS = [{ x: 100, w: 76, h: 150 }, { x: 218, w: 76, h: 230 }, { x: 336, w: 76, h: 310 }]
const BASELINE = 400

// All drawing in 512-space; 2×2 subsampling for smooth corners at small sizes.
function makeIcon(size, { round, contentScale = 1 }) {
  const rgba = Buffer.alloc(size * size * 4)
  const R = 90 // corner radius in 512-space
  const inBg = (u, v) => {
    if (!round) return true
    const cx = u < R ? R : u > 512 - R ? 512 - R : u
    const cy = v < R ? R : v > 512 - R ? 512 - R : v
    return (u - cx) ** 2 + (v - cy) ** 2 <= R * R || (u >= R && u <= 512 - R) || (v >= R && v <= 512 - R)
  }
  const inBar = (u, v) => {
    const uc = 256 + (u - 256) / contentScale
    const vc = 256 + (v - 256) / contentScale
    return BARS.some(b => uc >= b.x && uc <= b.x + b.w && vc >= BASELINE - b.h && vc <= BASELINE)
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, bar = 0
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const u = ((px + dx) / size) * 512, v = ((py + dy) / size) * 512
        if (inBg(u, v)) { bg++; if (inBar(u, v)) bar++ }
      }
      const i = (py * size + px) * 4
      const t = bar / 4 // white coverage over blue
      rgba[i] = BG[0] + (255 - BG[0]) * t
      rgba[i + 1] = BG[1] + (255 - BG[1]) * t
      rgba[i + 2] = BG[2] + (255 - BG[2]) * t
      rgba[i + 3] = (bg / 4) * 255
    }
  }
  return png(size, rgba)
}

const files = {
  'icon-192.png': makeIcon(192, { round: true }),
  'icon-512.png': makeIcon(512, { round: true }),
  'icon-maskable-512.png': makeIcon(512, { round: false, contentScale: 0.78 }), // full bleed, content in safe zone
  'apple-touch-icon.png': makeIcon(180, { round: false, contentScale: 0.85 }), // iOS applies its own mask
}
for (const [name, buf] of Object.entries(files)) {
  writeFileSync(join(OUT, name), buf)
  console.log(`${name}  ${buf.length} bytes`)
}
