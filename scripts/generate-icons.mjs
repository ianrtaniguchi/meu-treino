// Gera os ícones PNG do PWA com estética minimalista de luxo moderno ("black card / champagne gold"):
// Fundo escuro profundo (#07090E a #0D111A) com iluminação radial sutil, borda interna metálica fina
// em ouro champanhe (#D4AF37 / #E6C775) e monograma geométrico contínuo entrelaçado com chanfros de 45°.
// Uso: npm run icons
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePng(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v))
const mix = (a, b, t) => a + (b - a) * t
const mixRgb = (c1, c2, t) => [
  mix(c1[0], c2[0], t),
  mix(c1[1], c2[1], t),
  mix(c1[2], c2[2], t),
]

// SDF de caixa arredondada centrada em (0.5, 0.5)
function sdRoundedBox(x, y, hw, hh, r) {
  const qx = Math.abs(x - 0.5) - hw + r
  const qy = Math.abs(y - 0.5) - hh + r
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inn = Math.min(Math.max(qx, qy), 0)
  return out + inn - r
}

// Gradiente metálico ouro champanhe / platina
function champagneMetallic(u, v, facetBoost = 0) {
  const diag = clamp((u * 0.65 + v * 0.75), 0, 1)
  // Ondulação metálica suave (reflexo especular)
  const spec = Math.pow(clamp(1 - Math.abs(diag - 0.36) * 2.6, 0, 1), 1.8)
  const spec2 = Math.pow(clamp(1 - Math.abs(diag - 0.78) * 3.4, 0, 1), 2.0) * 0.65
  const baseDark = [152, 115, 32]   // #987320 bronze/ouro escuro
  const baseMid = [212, 175, 55]    // #D4AF37 ouro clássico
  const baseLight = [247, 231, 180] // #F7E7B4 champanhe platina

  let col = mixRgb(baseDark, baseMid, clamp(0.35 + 0.5 * (1 - diag), 0, 1))
  col = mixRgb(col, baseLight, clamp(spec + spec2 + facetBoost, 0, 1))
  return col
}

function pixel(u, v, scale) {
  // Fundo Obsidian (#07090E -> #111622) com brilho radial sutil
  const dxBg = u - 0.36
  const dyBg = v - 0.24
  const distBg = Math.hypot(dxBg, dyBg)
  const radial = clamp(1 - distBg / 0.95, 0, 1)

  const bgDeep = [7, 9, 14]      // #07090E
  const bgMid = [15, 20, 30]     // #0F141E
  let color = mixRgb(bgDeep, bgMid, Math.pow(radial, 1.35))

  // Halo central dourado super sutil
  const distCenter = Math.hypot(u - 0.5, v - 0.5)
  const goldGlow = Math.pow(clamp(1 - distCenter / 0.46, 0, 1), 2.4) * 0.11
  color = mixRgb(color, [212, 175, 55], goldGlow)

  // Coordenadas escaladas para o emblema e moldura (respeita safe-area do maskable)
  const x = (u - 0.5) / scale + 0.5
  const y = (v - 0.5) / scale + 0.5

  // 1. Moldura interna dupla fina metálica (estilo Black Card)
  const dOuterFrame = Math.abs(sdRoundedBox(x, y, 0.435, 0.435, 0.15))
  if (dOuterFrame < 0.0042) {
    const frameGold = champagneMetallic(x, y, 0.1)
    const alpha = clamp(1 - dOuterFrame / 0.0042, 0, 1) * 0.44
    color = mixRgb(color, frameGold, alpha)
  }

  const dInnerFrame = Math.abs(sdRoundedBox(x, y, 0.41, 0.41, 0.135))
  if (dInnerFrame < 0.0028) {
    const frameGold = champagneMetallic(x, y, 0)
    const alpha = clamp(1 - dInnerFrame / 0.0028, 0, 1) * 0.18
    color = mixRgb(color, frameGold, alpha)
  }

  // 2. Monograma Geométrico Contínuo (Infinito Entrelaçado com Chanfros de 45°)
  // Dois losangos entrelaçados centrados em (-0.115, 0) e (+0.115, 0) em coordenadas relativas ao centro
  const cx = x - 0.5
  const cy = y - 0.5

  const dLeft = Math.abs(cx + 0.112) + Math.abs(cy) // distância L1 (diamante esquerdo)
  const dRight = Math.abs(cx - 0.112) + Math.abs(cy) // distância L1 (diamante direito)

  const ringRadius = 0.175
  const ringHalfWidth = 0.033

  const inLeftRibbon = Math.abs(dLeft - ringRadius) <= ringHalfWidth
  const inRightRibbon = Math.abs(dRight - ringRadius) <= ringHalfWidth

  // Chanfro de entrelaçamento (over/under weave no cruzamento central)
  // No cruzamento superior (cy < 0), o elo esquerdo passa por cima com gap chanfrado;
  // No cruzamento inferior (cy > 0), o elo direito passa por cima com gap chanfrado.
  const gapMargin = 0.017
  const leftMaskedByRight =
    cy > 0 && Math.abs(dRight - ringRadius) <= ringHalfWidth + gapMargin
  const rightMaskedByLeft =
    cy <= 0 && Math.abs(dLeft - ringRadius) <= ringHalfWidth + gapMargin

  const drawLeft = inLeftRibbon && !leftMaskedByRight
  const drawRight = inRightRibbon && !rightMaskedByLeft

  if (drawLeft || drawRight) {
    // Calcula chanfro interno (bevel 3D ao longo da fita metálica)
    const dRibbon = drawLeft
      ? (dLeft - ringRadius) / ringHalfWidth
      : (dRight - ringRadius) / ringHalfWidth
    const ridge = 1 - Math.abs(dRibbon) // 1 na aresta central do chanfro, 0 nas bordas
    const facetSign = dRibbon < 0 ? 0.16 : -0.12
    const boost = (drawLeft ? 0.12 : 0.02) + facetSign + Math.pow(ridge, 3) * 0.24
    color = champagneMetallic(x, y, boost)
  }

  // Losango central facetado (joia/núcleo de precisão)
  const dCore = Math.abs(cx) + Math.abs(cy)
  if (dCore <= 0.044 && dCore >= 0.018) {
    const ridge = 1 - Math.abs((dCore - 0.031) / 0.013)
    color = champagneMetallic(x, y, 0.25 + ridge * 0.2)
  }

  // Acentos cardinais sutis (topo e base)
  const dTopAccent = Math.abs(cx) * 1.6 + Math.abs(cy + 0.295)
  const dBotAccent = Math.abs(cx) * 1.6 + Math.abs(cy - 0.295)
  if (dTopAccent <= 0.022 || dBotAccent <= 0.022) {
    color = mixRgb(color, champagneMetallic(x, y, 0.2), 0.78)
  }

  return color
}

function render(size, scale) {
  const SS = 4 // Supersampling 4x4 (16 amostras por pixel) para bordas ultra nítidas
  const buf = Buffer.alloc(size * size * 3)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = pixel((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, scale)
          r += c[0]; g += c[1]; b += c[2]
        }
      }
      const i = (py * size + px) * 3
      buf[i] = Math.round(r / (SS * SS))
      buf[i + 1] = Math.round(g / (SS * SS))
      buf[i + 2] = Math.round(b / (SS * SS))
    }
  }
  return encodePng(size, buf)
}

mkdirSync('public', { recursive: true })
writeFileSync('public/apple-touch-icon.png', render(180, 1))
writeFileSync('public/icon-192.png', render(192, 1))
writeFileSync('public/icon-512.png', render(512, 1))
writeFileSync('public/icon-maskable-512.png', render(512, 0.78))
writeFileSync('public/favicon.png', render(64, 1))
console.log('Ícones de luxo minimalista gerados em public/')
