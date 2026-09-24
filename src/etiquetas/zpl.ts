/**
 * Utilidades de bajo nivel para componer ZPL II.
 *
 * La GK420t trabaja a 8 puntos/mm (203 dpi, Zebra lo etiqueta como "200 dpi").
 */
export const PUNTOS_POR_MM = 8

export function mmAPuntos(mm: number): number {
  return Math.round(mm * PUNTOS_POR_MM)
}

/**
 * Normaliza un valor que viene de la base de datos: espacios sobrantes fuera.
 *
 * Se aplica a los datos de origen, antes de componer las líneas, para que los
 * separadores que añadimos nosotros no se vean afectados.
 */
export function normalizar(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim()
}

/**
 * Deja el texto listo para meterlo en un ^FD.
 *
 * `^` y `~` son los caracteres de comando y control de ZPL: si aparecen en los
 * datos, la impresora los interpreta y rompe la etiqueta. Se eliminan junto con
 * los caracteres de control. Ningún dato legítimo de paciente los contiene.
 *
 * Los espacios se respetan: a estas alturas ya son separadores de maquetación.
 */
export function limpiarParaZPL(texto: string): string {
  return texto
    .replace(/[\^~]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/ +$/, '')
}

/**
 * Ancho aproximado de un texto en la fuente escalable ^A0 (CG Triumvirate Bold
 * Condensed). No hay forma de medirlo exactamente sin consultar a la impresora,
 * así que se usa una proporción conservadora: prefiere quedarse corto y dejar
 * hueco antes que solapar campos.
 */
const PROPORCION_ANCHO = 0.58

export function anchoEstimado(texto: string, altura: number): number {
  return texto.length * altura * PROPORCION_ANCHO
}

export interface TextoAjustado {
  texto: string
  altura: number
}

/**
 * Reduce el cuerpo de letra hasta que el texto quepa en `anchoMaximo`.
 * Si ni al mínimo cabe, lo corta añadiendo un punto final de elipsis.
 */
export function ajustarAAncho(
  texto: string,
  alturaBase: number,
  anchoMaximo: number,
  alturaMinima = 16,
): TextoAjustado {
  let altura = alturaBase
  while (altura > alturaMinima && anchoEstimado(texto, altura) > anchoMaximo) {
    altura -= 1
  }

  if (anchoEstimado(texto, altura) <= anchoMaximo) {
    return { texto, altura }
  }

  const caracteresQueCaben = Math.max(1, Math.floor(anchoMaximo / (altura * PROPORCION_ANCHO)) - 1)
  return { texto: texto.slice(0, caracteresQueCaben) + '…', altura }
}

/** Campo de texto con fuente escalable, sin rotación. */
export function campoTexto(x: number, y: number, altura: number, texto: string): string {
  return `^FO${x},${y}^A0N,${altura},${altura}^FD${limpiarParaZPL(texto)}^FS`
}

/**
 * Código de barras Code 128 con línea de interpretación debajo.
 *
 * @param anchoModulo puntos por módulo estrecho (^BY). 2 es el mínimo fiable
 *                    para lectores de mano a 203 dpi.
 */
export function codigoBarras128(
  x: number,
  y: number,
  altura: number,
  dato: string,
  anchoModulo = 2,
): string {
  // El último parámetro de ^BC es el modo, y es imprescindible ponerlo a "A".
  // Sin él ZPL usa el subconjunto B y gasta un carácter por dígito; con modo
  // automático elige el subconjunto C y los empaqueta de dos en dos, lo que
  // deja el código en poco más de la mitad de ancho.
  return `^FO${x},${y}^BY${anchoModulo},3,${altura}^BCN,${altura},Y,N,N,A^FD${limpiarParaZPL(dato)}^FS`
}

/**
 * Alto real que ocupa `codigoBarras128`, contando la línea de interpretación.
 * El margen es generoso a propósito: la línea se dibuja con la fuente activa y
 * su alto exacto depende del estado de la impresora.
 */
export function altoCodigoBarras(alturaBarras: number): number {
  return alturaBarras + 30
}

/**
 * Ancho de un Code 128 generado en modo automático.
 *
 * Estructura: arranque (11 módulos) + un carácter por dato (11) + dígito de
 * control (11) + parada (13). Con solo dígitos, el subconjunto C mete dos por
 * carácter; si la cantidad es impar, uno se queda suelto y hace falta además un
 * carácter de cambio de subconjunto.
 */
export function anchoCodigoBarras(dato: string, anchoModulo = 2): number {
  const MODULOS_CARACTER = 11
  const MODULOS_PARADA = 13

  const caracteres = /^\d+$/.test(dato)
    ? dato.length % 2 === 0
      ? dato.length / 2
      : Math.floor(dato.length / 2) + 2
    : dato.length

  return (MODULOS_CARACTER * (1 + caracteres + 1) + MODULOS_PARADA) * anchoModulo
}

/**
 * Mayor ancho de módulo que hace que el código quepa en el espacio disponible.
 *
 * Un Code 128 recortado no es un código feo: es ilegible, porque pierde el
 * dígito de control y la parada. Más vale reducir el módulo que salirse.
 */
export function anchoModuloQueCabe(
  dato: string,
  anchoDisponible: number,
  preferido = 3,
): number | null {
  for (let modulo = preferido; modulo >= 2; modulo--) {
    if (anchoCodigoBarras(dato, modulo) <= anchoDisponible) return modulo
  }
  return null
}
