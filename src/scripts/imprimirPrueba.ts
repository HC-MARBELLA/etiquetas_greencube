/**
 * Imprime una etiqueta de prueba con datos ficticios en la impresora indicada.
 *
 *   npm run etiqueta:prueba                  -> 1 etiqueta, impresora por defecto
 *   npm run etiqueta:prueba -- 3             -> 3 etiquetas
 *   npm run etiqueta:prueba -- 1 extracciones
 */
import { buscarImpresora } from '../config.js'
import { datosDePrueba, generarEtiquetaPaciente } from '../etiquetas/etiquetaPaciente.js'
import { enviarZPL, leerEstado } from '../impresora/zebra.js'

const copias = Number(process.argv[2] ?? 1)
const impresora = buscarImpresora(process.argv[3])

console.log(`Impresora: ${impresora.nombre} (${impresora.host}:${impresora.puerto})`)

const estado = await leerEstado(impresora)
console.log('Estado:', estado)

if (!estado.accesible) {
  console.error('No se puede alcanzar la impresora. No se envía nada.')
  process.exit(1)
}
if (estado.sinPapel) {
  console.error('La impresora indica que no tiene etiquetas. No se envía nada.')
  process.exit(1)
}
if (estado.cabezalAbierto) {
  console.error('El cabezal está abierto. No se envía nada.')
  process.exit(1)
}

await enviarZPL(impresora, generarEtiquetaPaciente(datosDePrueba(), copias))
console.log(`Enviadas ${copias} etiqueta(s) de prueba.`)
