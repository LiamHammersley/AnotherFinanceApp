// Group colour coding: one hue per top-level category group. The default groups
// get fixed hues; custom groups hash into the palette deterministically so the
// colour is stable across sessions without storing anything.
export type GroupColour = { dot: string; bg: string; text: string }

const PALETTE: GroupColour[] = [
  { dot: '#10b981', bg: '#ecfdf5', text: '#047857' }, // emerald
  { dot: '#6366f1', bg: '#eef2ff', text: '#4338ca' }, // indigo
  { dot: '#06b6d4', bg: '#ecfeff', text: '#0e7490' }, // cyan
  { dot: '#f97316', bg: '#fff7ed', text: '#c2410c' }, // orange
  { dot: '#3b82f6', bg: '#eff6ff', text: '#1d4ed8' }, // blue
  { dot: '#f43f5e', bg: '#fff1f2', text: '#be123c' }, // rose
  { dot: '#d946ef', bg: '#fdf4ff', text: '#a21caf' }, // fuchsia
  { dot: '#8b5cf6', bg: '#f5f3ff', text: '#6d28d9' }, // violet
  { dot: '#14b8a6', bg: '#f0fdfa', text: '#0f766e' }, // teal
  { dot: '#84cc16', bg: '#f7fee7', text: '#4d7c0f' }, // lime
  { dot: '#f59e0b', bg: '#fffbeb', text: '#b45309' }, // amber
  { dot: '#64748b', bg: '#f8fafc', text: '#475569' }, // slate
]

// Default group set from migrations/0001_init.sql section 6.2
const DEFAULTS: Record<string, number> = {
  Income: 0, Housing: 1, Utilities: 2, 'Food & Drink': 3, Transport: 4, Health: 5,
  Personal: 6, Entertainment: 7, Financial: 8, Children: 9, 'Gifts & Charity': 10, Other: 11,
}

// The 12 hues offered when picking a group colour (the palette above, in order).
export const SWATCHES = PALETTE.map(p => p.dot)

const mix = (hex: string, towards: number, amount: number) => {
  const n = parseInt(hex.slice(1), 16)
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - amount) + towards * amount)
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
}

// Derive the chip background/text from any hex, so a user-chosen colour works
// the same as a palette one: a near-white tint behind darkened text.
export function colourFrom(hex: string): GroupColour {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return PALETTE[11]
  return { dot: hex, bg: mix(hex, 255, 0.9), text: mix(hex, 0, 0.35) }
}

export function groupColour(group: string, colour?: string | null): GroupColour {
  if (colour) return colourFrom(colour)
  if (group in DEFAULTS) return PALETTE[DEFAULTS[group]]
  let h = 0
  for (let i = 0; i < group.length; i++) h = (h * 31 + group.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

// A category's group is its parent (or itself for top-level categories)
export function categoryGroup(cats: any[], cat: any): any {
  return cats.find(c => c.id === cat?.parent_id) ?? cat
}

export function categoryColour(cats: any[], cat: any): GroupColour {
  const g = categoryGroup(cats, cat)
  return groupColour(g?.name ?? '', g?.colour)
}
