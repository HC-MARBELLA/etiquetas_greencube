import { config } from '../config.js'
import { mmAPuntos } from './zpl.js'

/**
 * Etiqueta de calibración: un marco que coincide exactamente con el área
 * imprimible declarada, más una regla en milímetros y marcas en las esquinas.
 *
 * Sirve para medir el descuadre en lugar de estimarlo a ojo:
 *
 *   - Si los cuatro lados del marco se ven completos y centrados, la etiqueta
 *     está bien alineada y el área declarada coincide con el papel.
 *   - Si falta un lado, el contenido se está saliendo por ahí. La regla dice
 *     cuántos milímetros, y eso es lo que hay que corregir con `^LH`.
 *   - Si el marco sale completo pero sobra papel en blanco, el papel es más
 *     grande de lo declarado en ETIQUETA_ANCHO_MM / ETIQUETA_ALTO_MM.
 */
export function generarEtiquetaCalibracion(): string {
  const ancho = mmAPuntos(config.etiqueta.anchoMm)
  const alto = mmAPuntos(config.etiqueta.altoMm)
  const metodo = config.etiqueta.metodo === 'directa' ? 'D' : 'T'

  const partes: string[] = [
    '^XA',
    '^CI28',
    `^MT${metodo}`,
    '^MNY',
    `^PW${ancho}`,
    `^LL${alto}`,
    '^LH0,0',
    '^LT0',
    '^PON',
  ]

  // Marco pegado al borde del área imprimible.
  partes.push(`^FO0,0^GB${ancho - 1},${alto - 1},3^FS`)

  // Marcas en las esquinas: si una se corta, el descuadre es por ese lado.
  const brazo = 40
  for (const [x, y, dx, dy] of [
    [0, 0, 1, 1],
    [ancho - 1, 0, -1, 1],
    [0, alto - 1, 1, -1],
    [ancho - 1, alto - 1, -1, -1],
  ] as const) {
    const xh = dx > 0 ? x : x - brazo
    const yv = dy > 0 ? y : y - brazo
    partes.push(`^FO${xh},${dy > 0 ? y : y - 8}^GB${brazo},8,8^FS`)
    partes.push(`^FO${dx > 0 ? x : x - 8},${yv}^GB8,${brazo},8^FS`)
  }

  // Regla horizontal cada 10 mm, desde el borde superior.
  for (let mm = 10; mm < config.etiqueta.anchoMm; mm += 10) {
    const x = mmAPuntos(mm)
    partes.push(`^FO${x},0^GB3,26,3^FS`)
    partes.push(`^FO${x + 6},4^A0N,18,18^FD${mm}^FS`)
  }

  // Regla vertical cada 5 mm, desde el borde izquierdo.
  for (let mm = 5; mm < config.etiqueta.altoMm; mm += 5) {
    const y = mmAPuntos(mm)
    partes.push(`^FO0,${y}^GB26,3,3^FS`)
    partes.push(`^FO32,${y - 9}^A0N,18,18^FD${mm}^FS`)
  }

  const centroY = Math.round(alto / 2) - 26
  partes.push(
    `^FO${Math.round(ancho / 2) - 150},${centroY}^A0N,24,24^FDCALIBRACION ${config.etiqueta.anchoMm}x${config.etiqueta.altoMm} mm^FS`,
  )
  partes.push(
    `^FO${Math.round(ancho / 2) - 150},${centroY + 28}^A0N,20,20^FD${ancho} x ${alto} puntos @ 203 dpi^FS`,
  )

  partes.push('^PQ1,0,0,N')
  partes.push('^XZ')
  partes.push('')

  return partes.join('\n')
}
