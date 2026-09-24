import sql from 'mssql'
import { config } from '../config.js'
import type {
  Agenda,
  Cita,
  DatosEtiqueta,
  Especialidad,
  FiltrosAgenda,
} from '../etiquetas/tipos.js'
import type { ProveedorDatos } from './proveedor.js'

/**
 * Proveedor contra PRIME, la base de datos de Green Cube (SQL Server).
 *
 * Todas las consultas son SELECT. **En PRIME no se escribe nunca**: el registro
 * de impresiones vive en la base SQLite propia de esta aplicación.
 *
 * Mapeo verificado campo a campo contra una etiqueta impresa. Los ejemplos son
 * los del paciente ficticio de `datosDePrueba()`:
 *
 *   00000001 - PR001          Customer.HISTORYNUMBER + ' - ' + Appointments.PROCESSID
 *   PRUEBA DE IMPRESIÓN       FIRSTSURNAME + SECONDSURNAME + NAMECUSTOMER
 *   X0000000T                 Customer.TIN
 *   01/01/1970                Customer.DATEBIRTH
 *   ASEGURADORA - CONVENIO    insurance.ENTITY + ' - ' + agreement.ENTITY
 *   CALLE DE PRUEBA 1         Customer.ADDRESS + ' ' + Customer.NUMBERADRESS
 *   Málaga                    Provinces.NAME  (la PROVINCIA, no la localidad:
 *                             TOWNVILLA y CITYNAME están vacíos en la práctica)
 *
 * El código de barras lleva solo HISTORYNUMBER, que nunca viene vacío
 * (verificado sobre las 107 citas de extracciones de un día completo).
 */

/** Marbella. Ceuta sería 9360, pero usa otra base de datos de facturación. */
const CENTRO = '9359'

/**
 * Paciente ficticio que Green Cube usa para bloquear huecos de agenda. Genera
 * cientos de "citas" al día y hay que excluirlo siempre.
 */
const PACIENTE_BLOQUEO = 'PACIENTE_BLOQUEO'

let pool: sql.ConnectionPool | null = null

async function conexion(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool

  if (!config.prime.host || !config.prime.usuario) {
    throw new Error(
      'Faltan las credenciales de PRIME. Rellena PRIME_HOST, PRIME_BASE, ' +
        'PRIME_USUARIO y PRIME_PASSWORD en .env, o arranca con ORIGEN_DATOS=mock.',
    )
  }

  pool = await new sql.ConnectionPool({
    server: config.prime.host,
    port: config.prime.puerto,
    database: config.prime.base || 'PatientManagement',
    user: config.prime.usuario,
    password: config.prime.password,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
      /**
       * SQL Server guarda DATETIME sin zona horaria: son horas de pared del
       * hospital. El driver las interpretaría como UTC, y en horario de verano
       * peninsular eso desplaza toda la agenda dos horas (una cita de las 08:00
       * se mostraría a las 10:00). Con esto se leen y escriben como hora local.
       */
      useUTC: false,
    },
    pool: { max: 8, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 15000,
  }).connect()

  return pool
}

/** Quita el relleno de los CHAR y colapsa los espacios sobrantes. */
function limpiar(valor: unknown): string {
  return typeof valor === 'string' ? valor.replace(/\s+/g, ' ').trim() : ''
}

/** Devuelve undefined en lugar de cadena vacía, para que la etiqueta omita la línea. */
function opcional(valor: unknown): string | undefined {
  return limpiar(valor) || undefined
}

/**
 * Identificador de cita para la interfaz. Appointments tiene clave compuesta,
 * así que se construye uno propio con las tres partes que la determinan.
 *
 * La fecha se serializa como hora de pared (`2026-09-23T08:00:00`, sin `Z`)
 * para que no haya conversiones de zona horaria en el viaje de ida y vuelta:
 * es la misma hora que guarda PRIME y la misma que se muestra en pantalla.
 */
function horaDePared(fecha: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())}` +
    `T${p(fecha.getHours())}:${p(fecha.getMinutes())}:${p(fecha.getSeconds())}`
  )
}

function componerId(customerId: string, processId: string, fecha: Date): string {
  return `${customerId.trim()}|${processId.trim()}|${horaDePared(fecha)}`
}

function descomponerId(id: string): { customerId: string; processId: string; fecha: Date } {
  const partes = id.split('|')
  if (partes.length !== 3) throw new Error(`Identificador de cita no válido: "${id}"`)
  // Sin sufijo de zona, `new Date` interpreta la cadena como hora local.
  const fecha = new Date(partes[2]!)
  if (Number.isNaN(fecha.getTime())) throw new Error(`Fecha no válida en la cita "${id}"`)
  return { customerId: partes[0]!, processId: partes[1]!, fecha }
}

/**
 * Cláusula IN parametrizada.
 *
 * Las agendas se filtran por CONSULTATIONCODEID y no por nombre porque los
 * nombres se repiten: hay tres agendas llamadas "ENFERMERÍA" y más de veinte
 * "MEDICINA GENERAL". Lo mismo con las especialidades.
 */
function filtroEn(
  peticion: sql.Request,
  columna: string,
  prefijo: string,
  valores: string[] | undefined,
  longitud: number,
): string {
  if (!valores || valores.length === 0) return ''
  const nombres = valores.map((v, i) => {
    peticion.input(`${prefijo}${i}`, sql.VarChar(longitud), v)
    return `@${prefijo}${i}`
  })
  return `AND RTRIM(${columna}) IN (${nombres.join(', ')})`
}

export const proveedorPrime: ProveedorDatos = {
  nombre: 'prime',

  async agendaDelDia(fecha: string, filtros: FiltrosAgenda = {}): Promise<Cita[]> {
    const cnx = await conexion()
    const peticion = cnx.request()
    peticion.input('fecha', sql.Date, fecha)
    peticion.input('centro', sql.VarChar(5), CENTRO)
    peticion.input('bloqueo', sql.VarChar(16), PACIENTE_BLOQUEO)

    const resultado = await peticion.query(`
      SELECT
        a.CUSTOMERID,
        a.PROCESSID,
        a.APPOINTMENTDATE,
        c.HISTORYNUMBER,
        c.NAMECUSTOMER,
        c.FIRSTSURNAMECUSTOMER,
        c.SECONDSURNAMECUSTOMER,
        s.CONSULTATIONCODEID,
        s.CONSULTATIONNAME,
        s.CONSULTATIONDESCRIPTION,
        sp.SPECIALTYDESCRIPTION
      FROM PatientManagement..Appointments a
      JOIN PatientManagement..Schedules s ON s.CONSULTATIONCODEID = a.CONSULTATIONID
      JOIN PatientManagement..Customer  c ON c.CUSTOMERID = a.CUSTOMERID
      LEFT JOIN Configuration..specialty sp
             ON RTRIM(sp.[KEY]) = RTRIM(s.CONSULTATIONSPECIALITYID)
      WHERE a.CUSTOMERID <> @bloqueo
        AND CONVERT(date, a.APPOINTMENTDATE) = @fecha
        AND RTRIM(s.HEALTHCENTREID) = @centro
        ${filtroEn(peticion, 's.CONSULTATIONCODEID', 'ag', filtros.agendas, 10)}
        ${filtroEn(peticion, 's.CONSULTATIONSPECIALITYID', 'esp', filtros.especialidades, 10)}
      ORDER BY a.APPOINTMENTDATE, c.FIRSTSURNAMECUSTOMER
    `)

    return resultado.recordset.map((f): Cita => {
      const fechaCita = new Date(f.APPOINTMENTDATE)
      const agenda = limpiar(f.CONSULTATIONNAME)
      const detalle = limpiar(f.CONSULTATIONDESCRIPTION)

      return {
        id: componerId(f.CUSTOMERID, f.PROCESSID, fechaCita),
        hora: fechaCita.toTimeString().slice(0, 5),
        paciente: [f.FIRSTSURNAMECUSTOMER, f.SECONDSURNAMECUSTOMER, f.NAMECUSTOMER]
          .map(limpiar)
          .filter(Boolean)
          .join(' '),
        episodio: `${limpiar(f.HISTORYNUMBER)} - ${limpiar(f.PROCESSID)}`,
        servicio: limpiar(f.SPECIALTYDESCRIPTION) || agenda,
        // El nombre de agenda solo no distingue: se añade el detalle (médico,
        // sala o tipo de extracción), que es lo que la hace reconocible.
        agenda: detalle && detalle !== agenda ? `${agenda} - ${detalle}` : agenda,
      }
    })
  },

  async especialidadesDisponibles(fecha: string): Promise<Especialidad[]> {
    const cnx = await conexion()
    const peticion = cnx.request()
    peticion.input('fecha', sql.Date, fecha)
    peticion.input('centro', sql.VarChar(5), CENTRO)
    peticion.input('bloqueo', sql.VarChar(16), PACIENTE_BLOQUEO)

    const resultado = await peticion.query(`
      SELECT RTRIM(sp.[KEY]) AS codigo,
             RTRIM(sp.SPECIALTYDESCRIPTION) AS nombre,
             COUNT(DISTINCT s.CONSULTATIONCODEID) AS agendas,
             COUNT(*) AS citas
      FROM PatientManagement..Appointments a
      JOIN PatientManagement..Schedules s ON s.CONSULTATIONCODEID = a.CONSULTATIONID
      JOIN Configuration..specialty sp
        ON RTRIM(sp.[KEY]) = RTRIM(s.CONSULTATIONSPECIALITYID)
      WHERE a.CUSTOMERID <> @bloqueo
        AND CONVERT(date, a.APPOINTMENTDATE) = @fecha
        AND RTRIM(s.HEALTHCENTREID) = @centro
      GROUP BY sp.[KEY], sp.SPECIALTYDESCRIPTION
      ORDER BY nombre
    `)

    return resultado.recordset.map((f): Especialidad => ({
      id: limpiar(f.codigo),
      nombre: limpiar(f.nombre),
      citas: Number(f.citas),
      agendas: Number(f.agendas),
    }))
  },

  async agendasDisponibles(fecha: string, especialidades: string[] = []): Promise<Agenda[]> {
    const cnx = await conexion()
    const peticion = cnx.request()
    peticion.input('fecha', sql.Date, fecha)
    peticion.input('centro', sql.VarChar(5), CENTRO)
    peticion.input('bloqueo', sql.VarChar(16), PACIENTE_BLOQUEO)

    const resultado = await peticion.query(`
      SELECT RTRIM(s.CONSULTATIONCODEID) AS codigo,
             RTRIM(s.CONSULTATIONNAME) AS nombre,
             RTRIM(ISNULL(s.CONSULTATIONDESCRIPTION,'')) AS detalle,
             RTRIM(ISNULL(s.CONSULTATIONSPECIALITYID,'')) AS especialidad,
             COUNT(*) AS citas
      FROM PatientManagement..Appointments a
      JOIN PatientManagement..Schedules s ON s.CONSULTATIONCODEID = a.CONSULTATIONID
      WHERE a.CUSTOMERID <> @bloqueo
        AND CONVERT(date, a.APPOINTMENTDATE) = @fecha
        AND RTRIM(s.HEALTHCENTREID) = @centro
        ${filtroEn(peticion, 's.CONSULTATIONSPECIALITYID', 'esp', especialidades, 10)}
      GROUP BY s.CONSULTATIONCODEID, s.CONSULTATIONNAME,
               s.CONSULTATIONDESCRIPTION, s.CONSULTATIONSPECIALITYID
      ORDER BY nombre, detalle
    `)

    return resultado.recordset.map((f): Agenda => {
      const nombre = limpiar(f.nombre)
      const detalle = limpiar(f.detalle)
      return {
        id: limpiar(f.codigo),
        nombre: detalle && detalle !== nombre ? `${nombre} - ${detalle}` : nombre,
        citas: Number(f.citas),
        especialidadId: limpiar(f.especialidad) || undefined,
      }
    })
  },

  async firmaDelDia(fecha: string): Promise<string> {
    const cnx = await conexion()
    const peticion = cnx.request()
    peticion.input('fecha', sql.Date, fecha)
    peticion.input('centro', sql.VarChar(5), CENTRO)
    peticion.input('bloqueo', sql.VarChar(16), PACIENTE_BLOQUEO)

    // CHECKSUM_AGG detecta altas, anulaciones y cambios de hora o de agenda
    // sin traerse las cientos de filas del día.
    const resultado = await peticion.query(`
      SELECT COUNT(*) AS n,
             CHECKSUM_AGG(CHECKSUM(
               a.CUSTOMERID, a.PROCESSID, a.APPOINTMENTDATE, a.CONSULTATIONID
             )) AS firma
      FROM PatientManagement..Appointments a
      JOIN PatientManagement..Schedules s ON s.CONSULTATIONCODEID = a.CONSULTATIONID
      WHERE a.CUSTOMERID <> @bloqueo
        AND CONVERT(date, a.APPOINTMENTDATE) = @fecha
        AND RTRIM(s.HEALTHCENTREID) = @centro
    `)

    const f = resultado.recordset[0]
    return `${f?.n ?? 0}:${f?.firma ?? 0}`
  },

  async datosEtiqueta(citaId: string): Promise<DatosEtiqueta> {
    const { customerId, processId, fecha } = descomponerId(citaId)

    const cnx = await conexion()
    const peticion = cnx.request()
    peticion.input('customerId', sql.VarChar(16), customerId)
    peticion.input('processId', sql.VarChar(5), processId)
    peticion.input('fecha', sql.DateTime, fecha)

    const resultado = await peticion.query(`
      SELECT TOP 1
        c.HISTORYNUMBER, c.NAMECUSTOMER, c.FIRSTSURNAMECUSTOMER, c.SECONDSURNAMECUSTOMER,
        c.TIN, c.DATEBIRTH, c.NUMBERPOLICY,
        c.ADDRESS, c.NUMBERADRESS, c.THREEPHONE, c.PHONEADRESS,
        a.PROCESSID, a.APPOINTMENTDATE,
        s.CONSULTATIONNAME,
        ins.ENTITY AS ASEGURADORA,
        ag.ENTITY  AS CONVENIO,
        p.NAME     AS PROVINCIA
      FROM PatientManagement..Appointments a
      JOIN PatientManagement..Schedules s ON s.CONSULTATIONCODEID = a.CONSULTATIONID
      JOIN PatientManagement..Customer  c ON c.CUSTOMERID = a.CUSTOMERID
      LEFT JOIN Configuration..agreement ag  ON ag.[KEY] = a.AGREEMENTID
      LEFT JOIN Configuration..insurance ins ON ins.[KEY] = ag.mutualid
      LEFT JOIN Configuration..Provinces p   ON RTRIM(p.[KEY]) = RTRIM(c.PROVINCEADRESSID)
      WHERE a.CUSTOMERID = @customerId
        AND a.PROCESSID  = @processId
        AND a.APPOINTMENTDATE = @fecha
    `)

    const f = resultado.recordset[0]
    if (!f) throw new Error(`No existe la cita "${citaId}"`)

    const historia = limpiar(f.HISTORYNUMBER)
    const aseguradora = limpiar(f.ASEGURADORA)
    const convenio = limpiar(f.CONVENIO)
    const domicilio = [limpiar(f.ADDRESS), limpiar(f.NUMBERADRESS)].filter(Boolean).join(' ')
    const cita = new Date(f.APPOINTMENTDATE)

    return {
      episodio: `${historia} - ${limpiar(f.PROCESSID)}`,
      // Solo el número de historia, que es lo que espera el lector del hospital.
      codigoBarras: historia,
      nombre: [f.FIRSTSURNAMECUSTOMER, f.SECONDSURNAMECUSTOMER, f.NAMECUSTOMER]
        .map(limpiar)
        .filter(Boolean)
        .join(' '),
      fechaNacimiento: f.DATEBIRTH
        ? new Date(f.DATEBIRTH).toLocaleDateString('es-ES')
        : undefined,
      documento: opcional(f.TIN),
      aseguradora:
        aseguradora && convenio
          ? `${aseguradora} - ${convenio}`
          : aseguradora || convenio || undefined,
      poliza: opcional(f.NUMBERPOLICY),
      servicio: opcional(f.CONSULTATIONNAME),
      // Cama solo aplica a hospitalización; en agenda de consulta no existe.
      cama: undefined,
      // La etiqueta actual imprime el fijo, que casi siempre está vacío.
      // Se prefiere el móvil, que es el que sirve para localizar al paciente.
      telefono: opcional(f.THREEPHONE) ?? opcional(f.PHONEADRESS),
      direccion: domicilio || undefined,
      poblacion: opcional(f.PROVINCIA),
      fechaAsistencia: `${cita.toLocaleDateString('es-ES')} ${cita.toTimeString().slice(0, 5)}`,
    }
  },
}

/** Cierra el pool al parar el servidor, para no dejar sesiones colgadas en PRIME. */
export async function cerrarPrime(): Promise<void> {
  if (pool) {
    await pool.close()
    pool = null
  }
}
