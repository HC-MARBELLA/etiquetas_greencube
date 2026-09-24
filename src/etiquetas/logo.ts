import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

/**
 * Conversión de un PNG a gráfico ZPL.
 *
 * La Zebra no entiende PNG: trabaja con mapas de bits de 1 bit por píxel en
 * formato GRF. Cada fila se empaqueta en bytes (8 píxeles por byte, el bit más
 * significativo a la izquierda) y se transmite en hexadecimal.
 *
 * Como el logo es siempre el mismo, conviene guardarlo una vez en la memoria
 * de la impresora (`~DG`) y referenciarlo desde cada etiqueta con `^XG`. Así no
 * se envían varios kilobytes en cada impresión.
 */

export interface GraficoZPL {
  /** Bytes por fila del mapa de bits. */
  bytesPorFila: number
  /** Total de bytes del mapa de bits. */
  totalBytes: number
  anchoPx: number
  altoPx: number
  /** Mapa de bits en hexadecimal, listo para ^GFA o ~DG. */
  hex: string
}

/**
 * Umbral por defecto de luminosidad. Un píxel más oscuro que esto se imprime
 * en negro. Los logos suelen ser negro sobre blanco, así que el punto medio
 * funciona bien; se puede ajustar si el logo tiene grises.
 */
const UMBRAL_POR_DEFECTO = 128

/** Región del PNG original a usar, en píxeles. Omitirla usa la imagen entera. */
export interface Recorte {
  x: number
  y: number
  ancho: number
  alto: number
}

export function convertirPNG(
  ruta: string,
  opciones: { umbral?: number; anchoMaximoPx?: number; recorte?: Recorte } = {},
): GraficoZPL {
  const umbral = opciones.umbral ?? UMBRAL_POR_DEFECTO
  const png = PNG.sync.read(readFileSync(ruta))

  // El recorte se aplica antes de escalar, para no desperdiciar resolución en
  // una zona que se va a descartar.
  const r = opciones.recorte ?? { x: 0, y: 0, ancho: png.width, alto: png.height }
  const recorteX = Math.max(0, Math.min(png.width - 1, Math.round(r.x)))
  const recorteY = Math.max(0, Math.min(png.height - 1, Math.round(r.y)))
  const recorteAncho = Math.max(1, Math.min(png.width - recorteX, Math.round(r.ancho)))
  const recorteAlto = Math.max(1, Math.min(png.height - recorteY, Math.round(r.alto)))

  const escala = opciones.anchoMaximoPx && recorteAncho > opciones.anchoMaximoPx
    ? opciones.anchoMaximoPx / recorteAncho
    : 1
  const anchoPx = Math.max(1, Math.round(recorteAncho * escala))
  const altoPx = Math.max(1, Math.round(recorteAlto * escala))

  const bytesPorFila = Math.ceil(anchoPx / 8)
  const buffer = Buffer.alloc(bytesPorFila * altoPx, 0)

  for (let y = 0; y < altoPx; y++) {
    // Cada punto de salida promedia todos los píxeles de origen que le
    // corresponden. Tomar solo el píxel central haría desaparecer del todo los
    // trazos finos al reducir: promediando, al menos ensombrecen su punto y
    // sobreviven subiendo el umbral.
    const desdeY = recorteY + Math.floor(y / escala)
    const hastaY = Math.max(desdeY + 1, recorteY + Math.floor((y + 1) / escala))

    for (let x = 0; x < anchoPx; x++) {
      const desdeX = recorteX + Math.floor(x / escala)
      const hastaX = Math.max(desdeX + 1, recorteX + Math.floor((x + 1) / escala))

      let suma = 0
      let muestras = 0

      for (let oy = desdeY; oy < Math.min(hastaY, recorteY + recorteAlto); oy++) {
        for (let ox = desdeX; ox < Math.min(hastaX, recorteX + recorteAncho); ox++) {
          const i = (png.width * oy + ox) << 2
          const r = png.data[i] ?? 255
          const g = png.data[i + 1] ?? 255
          const b = png.data[i + 2] ?? 255
          const alfa = png.data[i + 3] ?? 255

          // Lo transparente cuenta como blanco: no se imprime.
          suma += alfa < 128 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b
          muestras++
        }
      }

      const luminosidad = muestras === 0 ? 255 : suma / muestras

      if (luminosidad < umbral) {
        const indice = y * bytesPorFila + (x >> 3)
        buffer[indice] = (buffer[indice] ?? 0) | (0x80 >> (x & 7))
      }
    }
  }

  return {
    bytesPorFila,
    totalBytes: buffer.length,
    anchoPx,
    altoPx,
    hex: buffer.toString('hex').toUpperCase(),
  }
}

/**
 * Localiza los bloques horizontales de contenido del PNG, separados por franjas
 * de píxeles blancos que lo cruzan de lado a lado.
 *
 * En un logo con siglas encima y nombre debajo, esto devuelve un bloque por
 * cada parte, de forma que se puede quedar uno con las siglas sin tener que
 * calcular el recorte a mano. El wordmark es lo que impide reducir el logo:
 * ocupa altura y es lo primero que se rompe a 203 dpi.
 */
export function detectarBloques(ruta: string, umbral = UMBRAL_POR_DEFECTO): Recorte[] {
  const png = PNG.sync.read(readFileSync(ruta))

  const filaTieneTinta = (y: number): boolean => {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2
      const alfa = png.data[i + 3] ?? 255
      if (alfa < 128) continue
      const r = png.data[i] ?? 255
      const g = png.data[i + 1] ?? 255
      const b = png.data[i + 2] ?? 255
      if (0.299 * r + 0.587 * g + 0.114 * b < umbral) return true
    }
    return false
  }

  const bloques: Recorte[] = []
  let inicio: number | null = null

  for (let y = 0; y < png.height; y++) {
    const tinta = filaTieneTinta(y)
    if (tinta && inicio === null) inicio = y
    if (!tinta && inicio !== null) {
      bloques.push({ x: 0, y: inicio, ancho: png.width, alto: y - inicio })
      inicio = null
    }
  }
  if (inicio !== null) {
    bloques.push({ x: 0, y: inicio, ancho: png.width, alto: png.height - inicio })
  }

  // Se ajusta cada bloque a sus columnas con tinta, para quitar los márgenes
  // laterales en blanco que solo gastarían espacio en la etiqueta.
  return bloques.map((b) => {
    let minX = png.width
    let maxX = -1
    for (let y = b.y; y < b.y + b.alto; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = (png.width * y + x) << 2
        const alfa = png.data[i + 3] ?? 255
        if (alfa < 128) continue
        const r = png.data[i] ?? 255
        const g = png.data[i + 1] ?? 255
        const bl = png.data[i + 2] ?? 255
        if (0.299 * r + 0.587 * g + 0.114 * bl < umbral) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
    }
    return maxX < minX ? b : { x: minX, y: b.y, ancho: maxX - minX + 1, alto: b.alto }
  })
}

/** Comando para guardar el gráfico en la memoria permanente de la impresora. */
export function comandoGuardar(grafico: GraficoZPL, nombre = 'LOGO'): string {
  return `~DGE:${nombre}.GRF,${grafico.totalBytes},${grafico.bytesPorFila},${grafico.hex}`
}

/** Campo que dibuja un gráfico ya almacenado en la impresora. */
export function campoLogoAlmacenado(x: number, y: number, nombre = 'LOGO'): string {
  return `^FO${x},${y}^XGE:${nombre}.GRF,1,1^FS`
}

/** Campo que incrusta el gráfico en la propia etiqueta, sin almacenarlo. */
export function campoLogoIncrustado(x: number, y: number, grafico: GraficoZPL): string {
  return `^FO${x},${y}^GFA,${grafico.totalBytes},${grafico.totalBytes},${grafico.bytesPorFila},${grafico.hex}^FS`
}
