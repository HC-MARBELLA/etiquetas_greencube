/**
 * Genera el ZPL de una etiqueta, lo guarda en salida/prueba.zpl y verifica que
 * ningún elemento se salga del área imprimible.
 *
 * Si usas un visor online (labelary.com y similares) ten en cuenta que es un
 * servicio externo: solo con los datos ficticios de `datosDePrueba()`, nunca
 * con datos de un paciente real.
 *
 *   npm run etiqueta:previa
 *   npm run etiqueta:previa -- 3 c-003
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { raizProyecto } from '../config.js'
import {
  componerEtiqueta,
  datosDePrueba,
  verificarEncaje,
} from '../etiquetas/etiquetaPaciente.js'
import { proveedorMock } from '../datos/mock.js'

const copias = Number(process.argv[2] ?? 1)
const citaId = process.argv[3]

const datos = citaId ? await proveedorMock.datosEtiqueta(citaId) : datosDePrueba()
const etiqueta = componerEtiqueta(datos, copias)

console.log(etiqueta.zpl)

const carpeta = resolve(raizProyecto, 'salida')
mkdirSync(carpeta, { recursive: true })
const ruta = resolve(carpeta, 'prueba.zpl')
writeFileSync(ruta, etiqueta.zpl, 'utf8')

console.log(`Guardado en ${ruta}\n`)
console.log(`Área imprimible: ${etiqueta.limites.ancho} x ${etiqueta.limites.alto} puntos`)
console.log(`Módulo del código de barras: ${etiqueta.moduloCodigo} puntos\n`)

for (const caja of etiqueta.cajas) {
  const derecha = caja.x + caja.ancho
  const abajo = caja.y + caja.alto
  const holgura = etiqueta.limites.ancho - derecha
  console.log(
    `  ${caja.nombre.padEnd(34)} x ${String(caja.x).padStart(3)}..${String(derecha).padStart(3)}` +
      `  y ${String(caja.y).padStart(3)}..${String(abajo).padStart(3)}` +
      `  holgura derecha ${holgura}`,
  )
}

const problemas = verificarEncaje(etiqueta)
if (problemas.length === 0) {
  console.log('\nTodo dentro del área imprimible.')
} else {
  console.error('\nPROBLEMAS DE ENCAJE:')
  for (const p of problemas) console.error(`  - ${p}`)
  process.exit(1)
}
