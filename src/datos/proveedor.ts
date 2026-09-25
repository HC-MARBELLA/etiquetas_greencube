import { config } from '../config.js'
import type {
  Agenda,
  Cita,
  DatosEtiqueta,
  Especialidad,
  FiltrosAgenda,
  PacienteEncontrado,
} from '../etiquetas/tipos.js'
import { proveedorMock } from './mock.js'
import { proveedorPrime } from './prime.js'

/**
 * Origen de los datos de agenda y paciente.
 *
 * Existe esta interfaz para poder desarrollar contra datos ficticios sin tocar
 * PRIME. Cambiar de uno a otro es una variable de entorno, no un cambio de
 * código: ni las rutas ni la interfaz se enteran.
 */
export interface ProveedorDatos {
  readonly nombre: string

  /**
   * Citas de una fecha concreta, en formato YYYY-MM-DD, filtradas por agenda
   * y/o especialidad. Se consulta en vivo en cada petición: una cita que
   * acaben de dar de alta tiene que aparecer en el siguiente refresco.
   */
  agendaDelDia(fecha: string, filtros?: FiltrosAgenda): Promise<Cita[]>

  /** Especialidades con actividad ese día. */
  especialidadesDisponibles(fecha: string): Promise<Especialidad[]>

  /**
   * Agendas con citas ese día. Si se pasan especialidades, solo las de esas
   * especialidades — así los dos desplegables se encadenan.
   */
  agendasDisponibles(fecha: string, especialidades?: string[]): Promise<Agenda[]>

  /**
   * Huella del día: cambia si se da de alta, se anula o se mueve cualquier
   * cita. Es una agregación, mucho más barata que traerse el listado entero,
   * y permite vigilar PRIME cada pocos segundos sin castigarlo.
   */
  firmaDelDia(fecha: string): Promise<string>

  /** Datos necesarios para componer la etiqueta de una cita. */
  datosEtiqueta(citaId: string): Promise<DatosEtiqueta>

  /**
   * Busca un paciente por número de historia, al margen de la agenda.
   *
   * Para el paciente que llega sin cita. Devuelve null si no existe, en lugar
   * de lanzar: no encontrarlo es un resultado normal, no un error.
   */
  buscarPaciente(nhc: string): Promise<PacienteEncontrado | null>
}

export function obtenerProveedor(): ProveedorDatos {
  return config.origenDatos === 'prime' ? proveedorPrime : proveedorMock
}
