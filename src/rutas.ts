import type { FastifyInstance, FastifyRequest } from 'fastify'
import { buscarImpresora, config } from './config.js'
import { obtenerProveedor } from './datos/proveedor.js'
import {
  borrarVista,
  guardarVista,
  historialDeEpisodio,
  listarVistas,
  registrarImpresion,
  resumenDelDia,
} from './datos/registro.js'
import { generarEtiquetaPaciente } from './etiquetas/etiquetaPaciente.js'
import type { CitaConEstado } from './etiquetas/tipos.js'
import { enviarZPL, leerEstado } from './impresora/zebra.js'

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/

function hoy(): string {
  return new Date().toLocaleDateString('sv-SE') // sv-SE da YYYY-MM-DD en hora local
}

function validarCopias(valor: unknown): number {
  const copias = Number(valor ?? config.copiasPorDefecto)
  if (!Number.isInteger(copias) || copias < 1 || copias > config.copiasMaximas) {
    throw new Error(`El número de etiquetas debe estar entre 1 y ${config.copiasMaximas}`)
  }
  return copias
}

/** Identifica el puesto que imprime, para poder auditar quién hizo qué. */
function puestoDe(peticion: FastifyRequest): string {
  return peticion.ip
}

/** `?agenda=A&agenda=B` o `?agenda=A,B` acaban en la misma lista. */
function listaDeAgendas(valor: string | string[] | undefined): string[] {
  if (valor === undefined) return []
  const bruto = Array.isArray(valor) ? valor : [valor]
  return bruto.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
}

export async function registrarRutas(app: FastifyInstance): Promise<void> {
  const datos = obtenerProveedor()

  /**
   * Sonda de vida para Docker.
   *
   * Comprueba solo que el servidor responde y tiene su configuración cargada.
   * A propósito no consulta PRIME ni la impresora: si se acaban las etiquetas
   * o alguien apaga la Zebra, el contenedor no debe marcarse como enfermo ni
   * reiniciarse, porque la aplicación está perfectamente sana.
   */
  app.get('/salud', async () => ({
    ok: true,
    origenDatos: datos.nombre,
    impresoras: config.impresoras.length,
    hora: new Date().toISOString(),
  }))

  app.get('/api/config', async () => ({
    copiasPorDefecto: config.copiasPorDefecto,
    copiasMaximas: config.copiasMaximas,
    refrescoSegundos: config.refrescoSegundos,
    origenDatos: datos.nombre,
    impresoras: config.impresoras.map((i) => ({
      id: i.id,
      nombre: i.nombre,
      modelo: i.modelo,
      predeterminada: i.predeterminada,
    })),
  }))

  app.get<{
    Querystring: { fecha?: string; agenda?: string | string[]; especialidad?: string | string[] }
  }>('/api/agenda', async (peticion, respuesta) => {
    const fecha = peticion.query.fecha ?? hoy()
    if (!FECHA_ISO.test(fecha)) {
      return respuesta.status(400).send({ error: 'La fecha debe tener formato YYYY-MM-DD' })
    }

    const agendas = listaDeAgendas(peticion.query.agenda)
    const especialidades = listaDeAgendas(peticion.query.especialidad)

    // La consulta a la agenda y el resumen de impresiones se cruzan aquí:
    // el origen de datos no sabe nada de lo que hemos impreso nosotros.
    const [citas, impresas] = await Promise.all([
      datos.agendaDelDia(fecha, { agendas, especialidades }),
      Promise.resolve(resumenDelDia(fecha)),
    ])

    const conEstado: CitaConEstado[] = citas.map((c) => {
      const impresiones = impresas.get(c.episodio)
      return impresiones ? { ...c, impresiones } : c
    })

    return {
      fecha,
      agendas,
      especialidades,
      citas: conEstado,
      consultado: new Date().toISOString(),
    }
  })

  app.get<{ Querystring: { fecha?: string; especialidad?: string | string[] } }>(
    '/api/agendas',
    async (peticion, respuesta) => {
      const fecha = peticion.query.fecha ?? hoy()
      if (!FECHA_ISO.test(fecha)) {
        return respuesta.status(400).send({ error: 'La fecha debe tener formato YYYY-MM-DD' })
      }
      const especialidades = listaDeAgendas(peticion.query.especialidad)
      return { fecha, agendas: await datos.agendasDisponibles(fecha, especialidades) }
    },
  )

  app.get<{ Querystring: { fecha?: string } }>(
    '/api/especialidades',
    async (peticion, respuesta) => {
      const fecha = peticion.query.fecha ?? hoy()
      if (!FECHA_ISO.test(fecha)) {
        return respuesta.status(400).send({ error: 'La fecha debe tener formato YYYY-MM-DD' })
      }
      return { fecha, especialidades: await datos.especialidadesDisponibles(fecha) }
    },
  )

  app.get<{ Params: { episodio: string }; Querystring: { fecha?: string } }>(
    '/api/episodios/:episodio/impresiones',
    async (peticion) => ({
      episodio: peticion.params.episodio,
      historial: historialDeEpisodio(peticion.params.episodio, peticion.query.fecha ?? hoy()),
    }),
  )

  app.get<{ Params: { id: string } }>('/api/impresoras/:id/estado', async (peticion, respuesta) => {
    try {
      return await leerEstado(buscarImpresora(peticion.params.id))
    } catch (e) {
      return respuesta.status(404).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // --- Vistas guardadas -----------------------------------------------------

  app.get('/api/vistas', async () => ({ vistas: listarVistas() }))

  app.post<{
    Body: {
      nombre?: string
      agendas?: string[]
      especialidad?: string | null
      copias?: number
      impresoraId?: string
      ocultarImpresas?: boolean
    }
  }>('/api/vistas', async (peticion, respuesta) => {
    const nombre = peticion.body?.nombre?.trim()
    if (!nombre) return respuesta.status(400).send({ error: 'La vista necesita un nombre' })
    if (nombre.length > 60) {
      return respuesta.status(400).send({ error: 'El nombre no puede pasar de 60 caracteres' })
    }

    let copias: number | null = null
    if (peticion.body?.copias !== undefined) {
      try {
        copias = validarCopias(peticion.body.copias)
      } catch (e) {
        return respuesta.status(400).send({ error: e instanceof Error ? e.message : String(e) })
      }
    }

    if (peticion.body?.impresoraId) {
      try {
        buscarImpresora(peticion.body.impresoraId)
      } catch (e) {
        return respuesta.status(400).send({ error: e instanceof Error ? e.message : String(e) })
      }
    }

    guardarVista({
      nombre,
      agendas: peticion.body?.agendas ?? [],
      especialidad: peticion.body?.especialidad ?? null,
      copias,
      impresoraId: peticion.body?.impresoraId ?? null,
      ocultarImpresas: peticion.body?.ocultarImpresas ?? false,
    })

    return { ok: true, vistas: listarVistas() }
  })

  app.delete<{ Params: { id: string } }>('/api/vistas/:id', async (peticion, respuesta) => {
    const id = Number(peticion.params.id)
    if (!Number.isInteger(id)) return respuesta.status(400).send({ error: 'Identificador no válido' })
    borrarVista(id)
    return { ok: true, vistas: listarVistas() }
  })

  // --- Impresión ------------------------------------------------------------

  app.post<{ Body: { citaId?: string; copias?: number; impresoraId?: string; fecha?: string } }>(
    '/api/imprimir',
    async (peticion, respuesta) => {
      const { citaId, impresoraId } = peticion.body ?? {}
      if (!citaId) {
        return respuesta.status(400).send({ error: 'Falta el identificador de la cita' })
      }

      let copias: number
      let impresora
      try {
        copias = validarCopias(peticion.body?.copias)
        impresora = buscarImpresora(impresoraId)
      } catch (e) {
        return respuesta.status(400).send({ error: e instanceof Error ? e.message : String(e) })
      }

      let etiqueta
      try {
        etiqueta = await datos.datosEtiqueta(citaId)
      } catch (e) {
        return respuesta.status(404).send({ error: e instanceof Error ? e.message : String(e) })
      }

      // Se comprueba el estado antes de enviar: si falta papel o el cabezal
      // está abierto, el trabajo se quedaría en cola sin que nadie se entere.
      const estado = await leerEstado(impresora)
      if (!estado.accesible) {
        return respuesta
          .status(503)
          .send({ error: `La impresora no responde. ${estado.detalle ?? ''}`.trim() })
      }
      if (estado.sinPapel) {
        return respuesta.status(409).send({ error: 'La impresora no tiene etiquetas' })
      }
      if (estado.cabezalAbierto) {
        return respuesta.status(409).send({ error: 'El cabezal de la impresora está abierto' })
      }

      await enviarZPL(impresora, generarEtiquetaPaciente(etiqueta, copias))

      const fecha = peticion.body?.fecha ?? hoy()
      registrarImpresion({
        episodio: etiqueta.episodio,
        citaId,
        fecha,
        copias,
        impresora: impresora.id,
        puesto: puestoDe(peticion),
      })

      // Se registra el episodio, no el nombre: basta para auditoría y no deja
      // datos identificativos en el log.
      app.log.info(
        { citaId, episodio: etiqueta.episodio, copias, impresora: impresora.id },
        'etiquetas impresas',
      )

      return {
        ok: true,
        copias,
        impresora: impresora.nombre,
        impresiones: resumenDelDia(fecha).get(etiqueta.episodio),
      }
    },
  )

  // La impresión de prueba se hizo desde la interfaz mientras se ajustaba el
  // diseño de la etiqueta. Ya no pinta nada en un mostrador, donde solo estorba
  // y se puede pulsar sin querer. Para mantenimiento queda `npm run etiqueta:prueba`.
}
