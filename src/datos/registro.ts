import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../config.js'

/**
 * Base de datos propia de la aplicación.
 *
 * Aquí vive todo lo que es nuestro y no de Green Cube: qué etiquetas se han
 * impreso ya y las vistas guardadas de cada mostrador. **En PRIME no se
 * escribe nunca**: el acceso es de solo lectura y el histórico clínico no es
 * sitio para un registro de impresiones.
 *
 * Se usa el SQLite que trae Node, sin dependencias nativas, para que la imagen
 * de Docker siga siendo un `FROM node:alpine` sin herramientas de compilación.
 */

mkdirSync(dirname(config.rutaBaseDatos), { recursive: true })

const db = new DatabaseSync(config.rutaBaseDatos)

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS impresiones (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    episodio          TEXT    NOT NULL,
    cita_id           TEXT,
    fecha             TEXT    NOT NULL,
    copias            INTEGER NOT NULL,
    impresora         TEXT    NOT NULL,
    puesto            TEXT,
    creado_en         TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_impresiones_fecha ON impresiones (fecha);
  CREATE INDEX IF NOT EXISTS idx_impresiones_episodio ON impresiones (episodio, fecha);

  CREATE TABLE IF NOT EXISTS vistas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre            TEXT    NOT NULL UNIQUE,
    agendas           TEXT    NOT NULL DEFAULT '[]',
    copias            INTEGER,
    impresora_id      TEXT,
    creado_en         TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`)

/**
 * Añade una columna solo si falta, para no perder las vistas ya guardadas
 * cuando el esquema evoluciona.
 */
function asegurarColumna(tabla: string, columna: string, definicion: string): void {
  const existentes = db.prepare(`PRAGMA table_info(${tabla})`).all() as Array<{ name: string }>
  if (!existentes.some((c) => c.name === columna)) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`)
  }
}

asegurarColumna('vistas', 'ocultar_impresas', 'INTEGER NOT NULL DEFAULT 0')
asegurarColumna('vistas', 'especialidad', 'TEXT')

export interface ResumenImpresion {
  /** Total de etiquetas impresas para ese episodio en esa fecha. */
  copias: number
  /** Cuántas veces se ha pulsado imprimir. */
  veces: number
  /** Hora de la última impresión, HH:MM. */
  ultima: string
}

const sentencias = {
  registrar: db.prepare(`
    INSERT INTO impresiones (episodio, cita_id, fecha, copias, impresora, puesto)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  resumenDelDia: db.prepare(`
    SELECT episodio,
           SUM(copias)            AS copias,
           COUNT(*)               AS veces,
           substr(MAX(creado_en), 12, 5) AS ultima
    FROM impresiones
    WHERE fecha = ?
    GROUP BY episodio
  `),

  historialDeEpisodio: db.prepare(`
    SELECT copias, impresora, puesto, creado_en
    FROM impresiones
    WHERE episodio = ? AND fecha = ?
    ORDER BY creado_en DESC
    LIMIT 20
  `),

  listarVistas: db.prepare(`
    SELECT id, nombre, agendas, copias, especialidad,
           impresora_id     AS impresoraId,
           ocultar_impresas AS ocultarImpresas
    FROM vistas ORDER BY nombre
  `),

  guardarVista: db.prepare(`
    INSERT INTO vistas (nombre, agendas, copias, impresora_id, ocultar_impresas, especialidad)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (nombre) DO UPDATE SET
      agendas          = excluded.agendas,
      copias           = excluded.copias,
      impresora_id     = excluded.impresora_id,
      ocultar_impresas = excluded.ocultar_impresas,
      especialidad     = excluded.especialidad
  `),

  borrarVista: db.prepare('DELETE FROM vistas WHERE id = ?'),
}

export function registrarImpresion(datos: {
  episodio: string
  citaId?: string
  fecha: string
  copias: number
  impresora: string
  puesto?: string
}): void {
  sentencias.registrar.run(
    datos.episodio,
    datos.citaId ?? null,
    datos.fecha,
    datos.copias,
    datos.impresora,
    datos.puesto ?? null,
  )
}

/**
 * Qué se ha impreso ya en una fecha, indexado por episodio.
 *
 * Se agrupa por episodio y no por cita porque lo que se quiere evitar es
 * imprimir dos veces las etiquetas del mismo paciente, aunque la cita concreta
 * cambie de identificador al reprogramarla.
 */
export function resumenDelDia(fecha: string): Map<string, ResumenImpresion> {
  const filas = sentencias.resumenDelDia.all(fecha) as Array<{
    episodio: string
    copias: number
    veces: number
    ultima: string
  }>

  return new Map(
    filas.map((f) => [f.episodio, { copias: f.copias, veces: f.veces, ultima: f.ultima }]),
  )
}

export function historialDeEpisodio(episodio: string, fecha: string) {
  return sentencias.historialDeEpisodio.all(episodio, fecha)
}

export interface Vista {
  id: number
  nombre: string
  agendas: string[]
  especialidad: string | null
  copias: number | null
  impresoraId: string | null
  ocultarImpresas: boolean
}

export function listarVistas(): Vista[] {
  const filas = sentencias.listarVistas.all() as Array<{
    id: number
    nombre: string
    agendas: string
    especialidad: string | null
    copias: number | null
    impresoraId: string | null
    ocultarImpresas: number
  }>

  return filas.map((f) => ({
    ...f,
    agendas: JSON.parse(f.agendas) as string[],
    ocultarImpresas: f.ocultarImpresas === 1,
  }))
}

export function guardarVista(vista: {
  nombre: string
  agendas: string[]
  especialidad?: string | null
  copias?: number | null
  impresoraId?: string | null
  ocultarImpresas?: boolean
}): void {
  sentencias.guardarVista.run(
    vista.nombre,
    JSON.stringify(vista.agendas),
    vista.copias ?? null,
    vista.impresoraId ?? null,
    vista.ocultarImpresas ? 1 : 0,
    vista.especialidad ?? null,
  )
}

export function borrarVista(id: number): void {
  sentencias.borrarVista.run(id)
}

/**
 * Consolida el WAL en el fichero principal y cierra.
 *
 * En modo WAL los datos recién escritos viven en `etiquetas.db-wal` hasta que
 * se consolidan: sin esto, `etiquetas.db` se queda casi vacío y una copia de
 * seguridad que solo se lleve ese fichero parecería correcta y estaría vacía.
 */
export function cerrarRegistro(): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // Si no se puede consolidar, cerrar igualmente: el WAL sigue siendo válido.
  }
  db.close()
}
