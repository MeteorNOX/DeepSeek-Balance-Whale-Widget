/**
 * Absolutely minimal PNG reader — enough to sample a character image for its dominant colour.
 *
 * Why this exists: the appearance feature wants to derive the widget's accent colour from the
 * character art. `sharp` is present in the DSH installation, but it is NOT resolvable from a
 * linked plugin directory, so relying on it would silently degrade. A character PNG is always
 * small and unoptimised (the plugin's own upload path caps it at 20MB and the crop pipeline
 * writes a plain RGBA canvas PNG), so a compact reader is sufficient and dependency-free.
 *
 * Supported: 8-bit greyscale / RGB / palette / greyscale+alpha / RGBA, non-interlaced.
 * Not supported (reported honestly, not guessed): 16-bit, interlaced, tRNS.
 */

import zlib from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function channelsOf(colorType) {
  switch (colorType) {
    case 0: return 1 // greyscale
    case 2: return 3 // RGB
    case 3: return 1 // palette index
    case 4: return 2 // greyscale + alpha
    case 6: return 4 // RGBA
    default: return 0
  }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Decode a PNG buffer to 8-bit RGBA pixels.
 * @param {Buffer} buf
 * @returns {{width:number,height:number,pixels:Uint8Array}|null} null when unsupported/corrupt.
 */
export function decodePngToRgba(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 + 25) return null
    if (!buf.subarray(0, 8).equals(SIG)) return null

    let pos = 8
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
    let palette = null
    const idat = []

    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos)
      const type = buf.toString('ascii', pos + 4, pos + 8)
      const dataStart = pos + 8
      if (dataStart + len > buf.length) return null
      const data = buf.subarray(dataStart, dataStart + len)

      if (type === 'IHDR') {
        if (len < 13) return null
        width = data.readUInt32BE(0)
        height = data.readUInt32BE(4)
        bitDepth = data[8]
        colorType = data[9]
        interlace = data[12]
      } else if (type === 'PLTE') {
        palette = Buffer.from(data)
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(data))
      } else if (type === 'IEND') {
        break
      }
      pos = dataStart + len + 4 // + CRC
    }

    if (!width || !height) return null
    if (bitDepth !== 8) return null          // 16-bit not supported
    if (interlace !== 0) return null         // Adam7 not supported
    const ch = channelsOf(colorType)
    if (!ch) return null
    if (colorType === 3 && (!palette || palette.length < 3)) return null
    if (!idat.length) return null

    const raw = zlib.inflateSync(Buffer.concat(idat))
    const stride = width * ch
    if (raw.length < (stride + 1) * height) return null

    const out = new Uint8Array(width * height * 4)
    let prev = Buffer.alloc(stride)

    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]
      const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))

      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? line[i - ch] : 0
        const b = prev[i]
        const c = i >= ch ? prev[i - ch] : 0
        switch (filter) {
          case 0: break
          case 1: line[i] = (line[i] + a) & 255; break
          case 2: line[i] = (line[i] + b) & 255; break
          case 3: line[i] = (line[i] + ((a + b) >> 1)) & 255; break
          case 4: line[i] = (line[i] + paeth(a, b, c)) & 255; break
          default: return null
        }
      }

      for (let x = 0; x < width; x++) {
        const s = x * ch
        const d = (y * width + x) * 4
        if (colorType === 0) {
          out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255
        } else if (colorType === 2) {
          out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255
        } else if (colorType === 3) {
          const pi = line[s] * 3
          if (pi + 2 >= palette.length) return null
          out[d] = palette[pi]; out[d + 1] = palette[pi + 1]; out[d + 2] = palette[pi + 2]; out[d + 3] = 255
        } else if (colorType === 4) {
          out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1]
        } else {
          out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]
        }
      }
      prev = line
    }

    return { width, height, pixels: out }
  } catch (err) {
    return null
  }
}

/**
 * Dominant "character colour" of an RGBA image: the most common hue cluster, filtered to
 * drop transparency, near-white/near-black and near-grey pixels (antialiasing, outline, glow).
 * @param {Uint8Array} pixels RGBA
 * @param {(r:number,g:number,b:number)=>{h:number,s:number,l:number}} rgbToHsl
 * @returns {{h:number,s:number,l:number}|null}
 */
export function dominantHsl(pixels, rgbToHsl, { maxSamples = 20000 } = {}) {
  const total = Math.floor(pixels.length / 4)
  if (!total) return null
  const step = Math.max(1, Math.floor(total / maxSamples))

  const buckets = new Map()
  for (let i = 0; i < total; i += step) {
    const o = i * 4
    if (pixels[o + 3] < 160) continue
    const hsl = rgbToHsl(pixels[o], pixels[o + 1], pixels[o + 2])
    if (hsl.l > 0.96 || hsl.l < 0.05) continue
    if (hsl.s < 0.06) continue
    const key = Math.floor(hsl.h / 15)
    const b = buckets.get(key)
    if (b) { b.n++; b.s += hsl.s; b.l += hsl.l } else { buckets.set(key, { n: 1, s: hsl.s, l: hsl.l }) }
  }

  let best = null
  for (const [key, b] of buckets) {
    if (!best || b.n > best.n) best = { key, n: b.n, s: b.s / b.n, l: b.l / b.n }
  }
  if (!best) return null
  return { h: best.key * 15 + 7.5, s: best.s, l: best.l }
}
