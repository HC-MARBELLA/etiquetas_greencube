import { Socket } from 'node:net'
import type { Impresora } from '../config.js'

const TIEMPO_CONEXION_MS = 4000
/** Tope absoluto de espera de una consulta. */
const TIEMPO_RESPUESTA_MS = 3000
/**
 * La impresora no cierra la conexión tras responder, así que se da por
 * completa la respuesta cuando deja de llegar nada durante este tiempo.
 * Sin esto habría que esperar siempre el tope, y una impresión son dos
 * consultas: seis segundos de espera en el mostrador por cada etiqueta.
 */
const SILENCIO_MS = 200

/**
 * Abre una conexión TCP cruda contra el print server de la impresora.
 *
 * Las Zebra en red escuchan en el puerto 9100 y aceptan ZPL directamente, sin
 * driver ni cola de Windows de por medio. Eso es justo lo que nos interesa:
 * la impresora predeterminada del puesto deja de ser relevante.
 */
function conectar(impresora: Impresora): Promise<Socket> {
  return new Promise((resolver, rechazar) => {
    const socket = new Socket()
    socket.setTimeout(TIEMPO_CONEXION_MS)

    const fallar = (motivo: string) => {
      socket.destroy()
      rechazar(new Error(`${impresora.nombre} (${impresora.host}:${impresora.puerto}): ${motivo}`))
    }

    socket.once('connect', () => {
      socket.setTimeout(0)
      resolver(socket)
    })
    socket.once('timeout', () => fallar('no responde'))
    socket.once('error', (e) => fallar(e.message))

    socket.connect(impresora.puerto, impresora.host)
  })
}

/** Envía ZPL a la impresora y cierra. No espera confirmación de impresión. */
export async function enviarZPL(impresora: Impresora, zpl: string): Promise<void> {
  const socket = await conectar(impresora)

  await new Promise<void>((resolver, rechazar) => {
    socket.once('error', rechazar)
    // ^CI28 en la etiqueta indica UTF-8, así que se envían los bytes en UTF-8.
    socket.end(Buffer.from(zpl, 'utf8'), () => resolver())
  })
}

export interface EstadoImpresora {
  accesible: boolean
  modelo?: string
  firmware?: string
  sinPapel?: boolean
  cabezalAbierto?: boolean
  enPausa?: boolean
  /** Motivo cuando `accesible` es false, o aviso cuando el estado no se pudo leer. */
  detalle?: string
}

function consultar(impresora: Impresora, comando: string): Promise<string> {
  return conectar(impresora).then(
    (socket) =>
      new Promise<string>((resolver) => {
        const trozos: Buffer[] = []
        let silencio: NodeJS.Timeout | undefined

        const terminar = () => {
          clearTimeout(tope)
          if (silencio) clearTimeout(silencio)
          socket.destroy()
          resolver(Buffer.concat(trozos).toString('ascii'))
        }

        const tope = setTimeout(terminar, TIEMPO_RESPUESTA_MS)

        socket.on('data', (d) => {
          trozos.push(d)
          if (silencio) clearTimeout(silencio)
          silencio = setTimeout(terminar, SILENCIO_MS)
        })
        socket.once('close', terminar)
        socket.once('error', terminar)

        socket.write(comando)
      }),
  )
}

/**
 * Consulta modelo y estado de consumibles antes de imprimir.
 *
 * `~HI` devuelve "GK420t-200dpi,V61.17.17Z,8,2104KB".
 * `~HS` devuelve tres líneas de flags separadas por comas.
 *
 * La lectura de `~HS` es best-effort: algunos print servers no contestan según
 * cómo estén configurados, y en ese caso no se bloquea la impresión.
 */
export async function leerEstado(impresora: Impresora): Promise<EstadoImpresora> {
  let identificacion: string
  try {
    identificacion = await consultar(impresora, '~HI')
  } catch (e) {
    return { accesible: false, detalle: e instanceof Error ? e.message : String(e) }
  }

  const campos = identificacion.replace(/[\x00-\x1F]/g, '').split(',')
  const estado: EstadoImpresora = {
    accesible: true,
    modelo: campos[0]?.trim() || undefined,
    firmware: campos[1]?.trim() || undefined,
  }

  let respuestaEstado: string
  try {
    respuestaEstado = await consultar(impresora, '~HS')
  } catch {
    estado.detalle = 'No se pudo leer el estado de consumibles'
    return estado
  }

  const lineas = respuestaEstado
    .split(/[\r\n]+/)
    .map((l) => l.replace(/[\x00-\x1F]/g, '').trim())
    .filter(Boolean)

  const primera = lineas[0]?.split(',')
  const segunda = lineas[1]?.split(',')

  if (primera && segunda) {
    estado.sinPapel = primera[1] === '1'
    estado.enPausa = primera[2] === '1'
    estado.cabezalAbierto = segunda[2] === '1'
  } else {
    estado.detalle = 'No se pudo leer el estado de consumibles'
  }

  return estado
}
