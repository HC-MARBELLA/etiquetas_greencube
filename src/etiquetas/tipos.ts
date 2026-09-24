/**
 * Datos que se imprimen en una etiqueta de paciente.
 *
 * Todo es opcional salvo el episodio: la etiqueta se compone de forma dinámica
 * y las líneas sin valor no ocupan espacio. Así el mismo modelo sirve para
 * extracciones (sin cama) y para hospitalización (con cama).
 */
export interface DatosEtiqueta {
  /** Identificador completo visible en cabecera, p.ej. "00000001 - PR001" */
  episodio: string
  /** Lo que se codifica en el código de barras: el nº de historia, p.ej. "00000001" */
  codigoBarras: string
  nombre: string
  fechaNacimiento?: string
  documento?: string
  aseguradora?: string
  poliza?: string
  /** Servicio o unidad, p.ej. "ENFERMERÍA" */
  servicio?: string
  /** Solo hospitalización; en extracciones se omite */
  cama?: string
  telefono?: string
  direccion?: string
  poblacion?: string
  /** Formateada para impresión, p.ej. "22/09/2026 11:20" */
  fechaAsistencia?: string
}

/**
 * Una agenda del día.
 *
 * `id` y `nombre` van separados porque en PRIME los nombres se repiten: hay
 * tres agendas llamadas "ENFERMERÍA" y más de veinte "MEDICINA GENERAL". Se
 * filtra por `id` (CONSULTATIONCODEID) y se muestra `nombre`.
 */
export interface Agenda {
  id: string
  nombre: string
  citas?: number
  /** Especialidad a la que pertenece, para poder encadenar los filtros. */
  especialidadId?: string
}

/** Una especialidad con actividad ese día. */
export interface Especialidad {
  id: string
  nombre: string
  citas?: number
  agendas?: number
}

/** Filtros del listado. Vacío = sin restricción. */
export interface FiltrosAgenda {
  agendas?: string[]
  especialidades?: string[]
}

/** Una cita tal y como se muestra en el listado del mostrador. */
export interface Cita {
  id: string
  hora: string
  paciente: string
  episodio: string
  servicio?: string
  agenda?: string
}

/** Cita enriquecida con lo que esta aplicación sabe de ella. */
export interface CitaConEstado extends Cita {
  /** Ausente si todavía no se le ha impreso nada hoy. */
  impresiones?: {
    copias: number
    veces: number
    ultima: string
  }
}
