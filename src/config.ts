import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const aqui = dirname(fileURLToPath(import.meta.url))
export const raizProyecto = resolve(aqui, '..')

function texto(clave: string, porDefecto: string): string {
  const v = process.env[clave]
  return v === undefined || v === '' ? porDefecto : v
}

function numero(clave: string, porDefecto: number): number {
  const v = process.env[clave]
  if (v === undefined || v === '') return porDefecto
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${clave} debe ser un número, recibido "${v}"`)
  return n
}

function numeroOpcional(clave: string): number | undefined {
  const v = process.env[clave]
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${clave} debe ser un número, recibido "${v}"`)
  return n
}

export interface Impresora {
  id: string
  nombre: string
  host: string
  puerto: number
  modelo?: string
  predeterminada?: boolean
}

function cargarImpresoras(): Impresora[] {
  const ruta = resolve(raizProyecto, 'config', 'impresoras.json')
  const crudo: unknown = JSON.parse(readFileSync(ruta, 'utf8'))

  if (!Array.isArray(crudo) || crudo.length === 0) {
    throw new Error(`${ruta} debe contener un array con al menos una impresora`)
  }

  return crudo.map((entrada, i) => {
    const e = entrada as Partial<Impresora>
    if (!e.id || !e.host) {
      throw new Error(`Impresora #${i} en ${ruta}: faltan "id" y/o "host"`)
    }
    return {
      id: e.id,
      nombre: e.nombre ?? e.id,
      host: e.host,
      puerto: e.puerto ?? 9100,
      modelo: e.modelo,
      predeterminada: e.predeterminada ?? false,
    }
  })
}

export const config = {
  puerto: numero('PUERTO', 3000),
  host: texto('HOST', '0.0.0.0'),

  origenDatos: texto('ORIGEN_DATOS', 'mock') as 'mock' | 'prime',

  prime: {
    host: texto('PRIME_HOST', ''),
    puerto: numero('PRIME_PUERTO', 1433),
    base: texto('PRIME_BASE', ''),
    usuario: texto('PRIME_USUARIO', ''),
    password: texto('PRIME_PASSWORD', ''),
  },

  etiqueta: {
    metodo: texto('ETIQUETA_METODO', 'directa') as 'directa' | 'transferencia',
    anchoMm: numero('ETIQUETA_ANCHO_MM', 100),
    altoMm: numero('ETIQUETA_ALTO_MM', 35),
    margenMm: numero('ETIQUETA_MARGEN_MM', 2.5),

    /** Nombre del gráfico guardado en la impresora. Vacío = sin logo. */
    logo: texto('ETIQUETA_LOGO', ''),
    /** Tamaño reservado para el logo. Lo indica `npm run logo` al cargarlo. */
    logoAnchoPt: numero('ETIQUETA_LOGO_ANCHO_PT', 0),
    logoAltoPt: numero('ETIQUETA_LOGO_ALTO_PT', 0),
    contraste: numeroOpcional('ETIQUETA_CONTRASTE'),
    velocidad: numeroOpcional('ETIQUETA_VELOCIDAD'),
  },

  copiasPorDefecto: numero('COPIAS_POR_DEFECTO', 3),
  copiasMaximas: numero('COPIAS_MAXIMAS', 20),

  /**
   * Base de datos propia: registro de impresiones y vistas guardadas.
   * Nunca se escribe en PRIME, que es de solo lectura.
   */
  rutaBaseDatos: resolve(raizProyecto, texto('BASE_DATOS', 'datos/etiquetas.db')),

  /** Cada cuántos segundos refresca la agenda el navegador. */
  refrescoSegundos: numero('REFRESCO_SEGUNDOS', 25),

  impresoras: cargarImpresoras(),
} as const

export function buscarImpresora(id?: string): Impresora {
  if (id) {
    const encontrada = config.impresoras.find((i) => i.id === id)
    if (!encontrada) throw new Error(`No existe la impresora "${id}"`)
    return encontrada
  }
  return config.impresoras.find((i) => i.predeterminada) ?? config.impresoras[0]!
}
