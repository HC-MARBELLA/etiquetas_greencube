/**
 * Carga el logo del hospital en la memoria permanente de la impresora.
 *
 *   npm run logo -- logo.png                Convierte, sube e imprime prueba
 *   npm run logo -- logo.png 160            Limita el ancho a 160 puntos (20 mm)
 *   npm run logo -- logo.png 160 100        Ajusta también el umbral (0-255)
 *   npm run logo -- logo.png --bloques      Lista las partes del logo
 *   npm run logo -- logo.png 80 --bloque=1  Usa solo esa parte (p.ej. las siglas)
 *   npm run logo -- logo.png --comparar     Imprime varios tamaños en una etiqueta
 *   npm run logo -- logo.png 160 --previa   Solo calcula medidas, no imprime nada
 *
 * El logo queda guardado como E:LOGO.GRF dentro de la impresora, así que solo
 * hay que hacer esto una vez (y repetirlo si se cambia el logo). A partir de
 * ahí las etiquetas lo referencian con ^XG y pesan lo mismo que antes.
 */
import { buscarImpresora, config } from '../config.js'
import {
  campoLogoAlmacenado,
  campoLogoIncrustado,
  comandoGuardar,
  convertirPNG,
  detectarBloques,
  type Recorte,
} from '../etiquetas/logo.js'
import { mmAPuntos } from '../etiquetas/zpl.js'
import { enviarZPL } from '../impresora/zebra.js'

const argumentos = process.argv.slice(2)
const soloPrevia = argumentos.includes('--previa')
const comparar = argumentos.includes('--comparar')
const posicionales = argumentos.filter((a) => !a.startsWith('--'))

/**
 * En Windows, `npm run logo -- C:\Projects\Impresora etiquetas\logo.png` llega
 * partido en dos argumentos por el espacio de la ruta. Se reconstruye la ruta
 * juntando todo lo que hay antes del primer argumento numérico.
 */
const primerNumero = posicionales.findIndex((a) => /^\d+$/.test(a))
const corte = primerNumero === -1 ? posicionales.length : primerNumero
const ruta = posicionales.slice(0, corte).join(' ')
const numeros = posicionales.slice(corte)

if (!ruta) {
  console.error('Falta la ruta del PNG. Ejemplo: npm run logo -- logo.png 160')
  process.exit(1)
}

const anchoMaximoPx = numeros[0] ? Number(numeros[0]) : 160
const umbral = numeros[1] ? Number(numeros[1]) : undefined

const anchoEtiquetaPt = mmAPuntos(config.etiqueta.anchoMm)
const altoEtiquetaPt = mmAPuntos(config.etiqueta.altoMm)
const margenPt = mmAPuntos(config.etiqueta.margenMm)
const altoUtilPt = altoEtiquetaPt - margenPt * 2

// Los bloques permiten quedarse solo con una parte del logo (por ejemplo las
// siglas sin el wordmark), que es lo que deja reducirlo de verdad.
const bloques = detectarBloques(ruta, umbral)
const argBloque = argumentos.find((a) => a.startsWith('--bloque='))

if (argumentos.includes('--bloques')) {
  console.log(`${ruta}: ${bloques.length} bloque(s) de contenido\n`)
  bloques.forEach((b, i) => {
    console.log(
      `  --bloque=${i + 1}  ${b.ancho}x${b.alto} px en (${b.x},${b.y})  proporción ${(b.ancho / b.alto).toFixed(2)}`,
    )
  })
  console.log('\nUsa --bloque=N para quedarte solo con esa parte.')
  process.exit(0)
}

let recorte: Recorte | undefined

// Con el logo completo interesa quitarle el margen en blanco que trae el PNG:
// a igualdad de tamaño impreso, el dibujo queda más grande.
if (argumentos.includes('--ajustado') && bloques.length > 0) {
  const x = Math.min(...bloques.map((b) => b.x))
  const y = Math.min(...bloques.map((b) => b.y))
  const derecha = Math.max(...bloques.map((b) => b.x + b.ancho))
  const abajo = Math.max(...bloques.map((b) => b.y + b.alto))
  recorte = { x, y, ancho: derecha - x, alto: abajo - y }
}

if (argBloque) {
  const n = Number(argBloque.split('=')[1])
  if (!Number.isInteger(n) || n < 1 || n > bloques.length) {
    console.error(`--bloque debe estar entre 1 y ${bloques.length}. Usa --bloques para verlos.`)
    process.exit(1)
  }
  recorte = bloques[n - 1]
}

function cabeceraZPL(): string[] {
  return [
    '^XA',
    '^CI28',
    `^MT${config.etiqueta.metodo === 'directa' ? 'D' : 'T'}`,
    '^MNY',
    `^PW${anchoEtiquetaPt}`,
    `^LL${altoEtiquetaPt}`,
    '^LH0,0',
    '^LT0',
  ]
}

/**
 * Imprime el mismo logo a varios tamaños en una sola etiqueta.
 *
 * Los trazos finos de un logo se rompen a 203 dpi cuando bajan de dos puntos de
 * grosor, y eso no se puede predecir con fiabilidad desde el fichero: hay que
 * verlo impreso. Esto convierte la decisión en un vistazo.
 */
if (comparar) {
  const anchos = recorte ? [64, 80, 96, 128] : [96, 128, 160, 200]
  const graficos = anchos.map((a) => ({
    ancho: a,
    g: convertirPNG(ruta, { anchoMaximoPx: a, umbral, recorte }),
  }))

  const partes = cabeceraZPL()

  let x = 12
  for (const { ancho, g } of graficos) {
    partes.push(campoLogoIncrustado(x, 12, g))
    partes.push(`^FO${x},${12 + g.altoPx + 6}^A0N,18,18^FD${ancho}pt^FS`)
    x += g.anchoPx + 16
  }

  partes.push('^PQ1,0,0,N', '^XZ', '')
  const zpl = partes.join('\n')

  console.log(
    `Comparativa de ${anchos.join(', ')} puntos de ancho${recorte ? ' (solo el bloque elegido)' : ''}`,
  )
  console.log(`Tamaño del trabajo: ${(zpl.length / 1024).toFixed(1)} KB`)

  if (x > anchoEtiquetaPt) {
    console.error(`No caben los cuatro tamaños (harían falta ${x} pt de ${anchoEtiquetaPt}).`)
    process.exit(1)
  }
  if (soloPrevia) {
    console.log('Modo vista previa: no se ha enviado nada a la impresora.')
    process.exit(0)
  }

  const destino = buscarImpresora()
  await enviarZPL(destino, zpl)
  console.log(`Comparativa enviada a ${destino.nombre}. Elige el más pequeño que se lea bien.`)
  process.exit(0)
}

let grafico
try {
  grafico = convertirPNG(ruta, { anchoMaximoPx, umbral, recorte })
} catch (e) {
  console.error(`No se pudo leer "${ruta}": ${e instanceof Error ? e.message : String(e)}`)
  console.error('Si la ruta lleva espacios, entrecomíllala o usa una ruta relativa.')
  process.exit(1)
}

console.log(`Origen:    ${ruta}${recorte ? ` (bloque ${argBloque?.split('=')[1]})` : ''}`)
console.log(`Resultado: ${grafico.anchoPx} x ${grafico.altoPx} puntos`)
console.log(`           ${(grafico.anchoPx / 8).toFixed(1)} x ${(grafico.altoPx / 8).toFixed(1)} mm a 203 dpi`)
console.log(`           ${grafico.totalBytes} bytes (${grafico.bytesPorFila} por fila)`)
console.log(`           ocupa el ${((grafico.altoPx / altoUtilPt) * 100).toFixed(0)}% del alto útil de la etiqueta`)
console.log('\nPara .env:')
console.log('  ETIQUETA_LOGO=LOGO')
console.log(`  ETIQUETA_LOGO_ANCHO_PT=${grafico.anchoPx}`)
console.log(`  ETIQUETA_LOGO_ALTO_PT=${grafico.altoPx}`)

if (grafico.altoPx > altoUtilPt) {
  console.error(`\nEl logo es más alto que la etiqueta (${altoUtilPt} pt útiles). Reduce el ancho.`)
  process.exit(1)
}

// La GK420t tiene 1536 KB de flash; un logo razonable ocupa unos pocos KB.
if (grafico.totalBytes > 100_000) {
  console.error('\nEl logo es demasiado grande. Reduce el ancho máximo.')
  process.exit(1)
}

if (soloPrevia) {
  console.log('\nModo vista previa: no se ha enviado nada a la impresora.')
  process.exit(0)
}

const impresora = buscarImpresora()
console.log(`\nImpresora: ${impresora.nombre} (${impresora.host}:${impresora.puerto})`)

await enviarZPL(impresora, comandoGuardar(grafico))
console.log('Logo guardado en la impresora como E:LOGO.GRF')

// Prueba visual. El marco se dibuja en el margen, no en el borde del papel:
// sabemos que el borde se pierde, y lo que interesa comprobar es que el área
// segura sale entera.
await enviarZPL(
  impresora,
  cabeceraZPL()
    .concat([
      campoLogoAlmacenado(margenPt, margenPt),
      `^FO${margenPt},${margenPt}^GB${anchoEtiquetaPt - margenPt * 2},${altoUtilPt},2^FS`,
      `^FO${margenPt + grafico.anchoPx + 12},${margenPt + 6}^A0N,20,20^FDLogo ${grafico.anchoPx}x${grafico.altoPx} pt^FS`,
      '^PQ1,0,0,N',
      '^XZ',
      '',
    ])
    .join('\n'),
)
console.log('Enviada etiqueta de prueba con el logo y el marco del área segura.')
