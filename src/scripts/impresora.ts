/**
 * Utilidades de mantenimiento de la impresora.
 *
 *   npm run impresora estado            Modelo, firmware y consumibles
 *   npm run impresora patron            Imprime la etiqueta de calibración
 *   npm run impresora calibrar-sensor   Mide el papel cargado (~JC)
 *   npm run impresora termica-directa   Fija papel térmico sin ribbon, permanente
 *   npm run impresora transferencia     Vuelve a transferencia térmica (con ribbon)
 *   npm run impresora config            Vuelca la configuración completa (~HQ)
 *
 * Se puede indicar la impresora como segundo argumento:
 *   npm run impresora patron extracciones
 */
import { buscarImpresora } from '../config.js'
import { generarEtiquetaCalibracion } from '../etiquetas/etiquetaCalibracion.js'
import { enviarZPL, leerEstado } from '../impresora/zebra.js'

const accion = process.argv[2]
const impresora = buscarImpresora(process.argv[3])

console.log(`Impresora: ${impresora.nombre} (${impresora.host}:${impresora.puerto})\n`)

switch (accion) {
  case 'estado': {
    console.log(await leerEstado(impresora))
    break
  }

  case 'patron': {
    await enviarZPL(impresora, generarEtiquetaCalibracion())
    console.log('Etiqueta de calibración enviada.')
    console.log('Mide el marco impreso y compáralo con la regla que lleva dentro.')
    break
  }

  case 'calibrar-sensor': {
    // ~JC hace que la impresora avance y mida el papel cargado para ajustar
    // el sensor de espacio. Consume dos o tres etiquetas.
    await enviarZPL(impresora, '~JC')
    console.log('Calibración de sensor lanzada. Consume 2-3 etiquetas.')
    break
  }

  case 'termica-directa': {
    // ^JUS guarda la configuración en la memoria permanente de la impresora.
    await enviarZPL(impresora, '^XA^MTD^JUS^XZ')
    console.log('Método de impresión fijado a TÉRMICA DIRECTA (permanente).')
    break
  }

  case 'transferencia': {
    await enviarZPL(impresora, '^XA^MTT^JUS^XZ')
    console.log('Método de impresión fijado a TRANSFERENCIA TÉRMICA (permanente).')
    break
  }

  case 'config': {
    // ^HH devuelve la configuración al canal de comunicaciones.
    await enviarZPL(impresora, '^XA^HH^XZ')
    console.log('Solicitada la configuración. Consúltala en http://' + impresora.host + '/config.html')
    break
  }

  default: {
    console.error(
      'Acción no reconocida. Usa: estado | patron | calibrar-sensor | termica-directa | transferencia | config',
    )
    process.exit(1)
  }
}
