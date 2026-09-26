// Accent recoloring in OKLCH, so a hue change keeps each color's lightness.
// The design was drawn in blue; every accent is that design rotated.

export type RGB = [number, number, number]

/** OKLCH hue of the original blue accent. */
export const BASE_HUE = 262

export interface Accent {
  /** OKLCH hue, 0..360. */
  hue: number
  /** Chroma scale: 1 = full color, 0 = graphite. */
  chroma: number
}

export const DEFAULT_ACCENT: Accent = { hue: BASE_HUE, chroma: 1 }

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function toOklab([r, g, b]: RGB): RGB {
  const [R, G, B] = [toLin(r), toLin(g), toLin(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

function fromOklab([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb: RGB = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  return rgb.map((c) => Math.min(1, Math.max(0, toSrgb(c)))) as RGB
}

/** Recolor one of the design's blues to the accent. Colors that are not blue (amber, red) are left alone. */
export function tint(rgb: RGB, accent: Accent): RGB {
  const [L, a, b] = toOklab(rgb)
  const hue = (Math.atan2(b, a) * 180) / Math.PI
  const h = (hue + 360) % 360
  if (h < 200 || h > 310) return rgb
  const c = Math.hypot(a, b) * accent.chroma
  const nh = ((h + accent.hue - BASE_HUE) * Math.PI) / 180
  return fromOklab([L, c * Math.cos(nh), c * Math.sin(nh)])
}
