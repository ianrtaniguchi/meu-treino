// Gera os ícones do app (PNG) sem nenhuma dependência: desenha pixels e codifica PNG com zlib.
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
  ihdr[8] = 8 // 8 bits
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Desenho em coordenadas 0..1: fundo #0d1117 liso + halter minimalista em verde #39d353.
// "scale" reduz o desenho (usado no ícone maskable, que precisa de margem de segurança).
function pixel(u, v, scale) {
  const x = (u - 0.5) / scale + 0.5
  const y = (v - 0.5) / scale + 0.5
  const inRect = (x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1
  const halter =
    inRect(0.3, 0.47, 0.7, 0.53) || // barra
    inRect(0.22, 0.34, 0.3, 0.66) || inRect(0.7, 0.34, 0.78, 0.66) // anilhas
  return halter ? [57, 211, 83] : [13, 17, 23]
}
function render(size, scale) {
  const SS = 3 // supersampling para suavizar as bordas
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
      buf[i] = Math.round(r / SS / SS)
      buf[i + 1] = Math.round(g / SS / SS)
      buf[i + 2] = Math.round(b / SS / SS)
    }
  }
  return encodePng(size, buf)
}

mkdirSync('public', { recursive: true })
writeFileSync('public/apple-touch-icon.png', render(180, 1))
writeFileSync('public/icon-192.png', render(192, 1))
writeFileSync('public/icon-512.png', render(512, 1))
writeFileSync('public/icon-maskable-512.png', render(512, 0.7))
writeFileSync('public/favicon.png', render(64, 1))
console.log('Ícones gerados em public/')
