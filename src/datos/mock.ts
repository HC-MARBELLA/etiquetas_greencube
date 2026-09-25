import type {
  Agenda,
  Cita,
  DatosEtiqueta,
  Especialidad,
  FiltrosAgenda,
  PacienteEncontrado,
} from '../etiquetas/tipos.js'
import { normalizarNhc } from './prime.js'
import type { ProveedorDatos } from './proveedor.js'

/**
 * Datos completamente inventados para desarrollo.
 *
 * Nunca se deben meter aquí datos de pacientes reales: este fichero va a Git.
 */
interface Registro {
  cita: Omit<Cita, 'hora'> & { hora: string }
  etiqueta: DatosEtiqueta
}

const REGISTROS: Registro[] = [
  {
    cita: {
      id: 'c-001',
      hora: '08:15',
      paciente: 'GARCÍA LÓPEZ, MARÍA',
      episodio: '00200001 - CC002',
      servicio: 'ENFERMERÍA',
      agenda: 'Extracciones',
    },
    etiqueta: {
      episodio: '00200001 - CC002',
      codigoBarras: '00200001',
      nombre: 'GARCÍA LÓPEZ, MARÍA',
      fechaNacimiento: '14/05/1982',
      documento: '11111111H',
      aseguradora: 'ASEGURADORA DEMO SA',
      poliza: '1111111110000000001',
      servicio: 'ENFERMERÍA',
      telefono: '600000001',
      direccion: 'CALLE FICTICIA 1',
      poblacion: 'Málaga',
      fechaAsistencia: '23/09/2026 08:15',
    },
  },
  {
    cita: {
      id: 'c-002',
      hora: '08:30',
      paciente: 'FERNÁNDEZ RUIZ, JOSÉ ANTONIO',
      episodio: '00200002 - CC002',
      servicio: 'ENFERMERÍA',
      agenda: 'Extracciones',
    },
    etiqueta: {
      episodio: '00200002 - CC002',
      codigoBarras: '00200002',
      nombre: 'FERNÁNDEZ RUIZ, JOSÉ ANTONIO',
      fechaNacimiento: '02/11/1965',
      documento: '22222222J',
      aseguradora: 'ASEGURADORA DEMO SA',
      poliza: '2222222220000000002',
      servicio: 'ENFERMERÍA',
      telefono: '600000002',
      direccion: 'AVENIDA INVENTADA 45, 3º B',
      poblacion: 'Málaga',
      fechaAsistencia: '23/09/2026 08:30',
    },
  },
  {
    // Caso de hospitalización: con cama, para comprobar que la línea aparece.
    cita: {
      id: 'c-003',
      hora: '09:00',
      paciente: 'DE LA TORRE MONTESINOS, INMACULADA CONCEPCIÓN',
      episodio: '00200003 - HO001',
      servicio: 'HOSPITALIZACIÓN',
      agenda: 'Planta 2',
    },
    etiqueta: {
      episodio: '00200003 - HO001',
      codigoBarras: '00200003',
      nombre: 'DE LA TORRE MONTESINOS, INMACULADA CONCEPCIÓN',
      fechaNacimiento: '30/07/1948',
      documento: '33333333P',
      aseguradora: 'ASEGURADORA DEMO SA',
      poliza: '3333333330000000003',
      servicio: 'HOSPITALIZACIÓN',
      cama: '214-A',
      telefono: '600000003',
      direccion: 'PLAZA IMAGINARIA 7',
      poblacion: 'Marbella',
      fechaAsistencia: '23/09/2026 09:00',
    },
  },
  {
    // Caso mínimo: solo lo imprescindible, para ver cómo se recompone.
    cita: {
      id: 'c-004',
      hora: '09:20',
      paciente: 'SMITH, JOHN',
      episodio: '00200004 - CC002',
      servicio: 'ENFERMERÍA',
      agenda: 'Extracciones',
    },
    etiqueta: {
      episodio: '00200004 - CC002',
      codigoBarras: '00200004',
      nombre: 'SMITH, JOHN',
      fechaNacimiento: '20/03/1980',
      servicio: 'ENFERMERÍA',
      fechaAsistencia: '23/09/2026 09:20',
    },
  },
]

export const proveedorMock: ProveedorDatos = {
  nombre: 'mock',

  async agendaDelDia(_fecha: string, filtros: FiltrosAgenda = {}): Promise<Cita[]> {
    return REGISTROS.map((r) => r.cita).filter((c) => {
      if (filtros.agendas?.length && !filtros.agendas.includes(c.agenda ?? '')) return false
      if (filtros.especialidades?.length && !filtros.especialidades.includes(c.servicio ?? '')) {
        return false
      }
      return true
    })
  },

  async especialidadesDisponibles(_fecha: string): Promise<Especialidad[]> {
    const conteo = new Map<string, { citas: number; agendas: Set<string> }>()
    for (const { cita } of REGISTROS) {
      if (!cita.servicio) continue
      const entrada = conteo.get(cita.servicio) ?? { citas: 0, agendas: new Set<string>() }
      entrada.citas++
      if (cita.agenda) entrada.agendas.add(cita.agenda)
      conteo.set(cita.servicio, entrada)
    }
    return [...conteo.entries()]
      .map(([nombre, v]): Especialidad => ({
        id: nombre,
        nombre,
        citas: v.citas,
        agendas: v.agendas.size,
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  },

  async agendasDisponibles(_fecha: string, especialidades: string[] = []): Promise<Agenda[]> {
    const conteo = new Map<string, { citas: number; especialidad?: string }>()
    for (const { cita } of REGISTROS) {
      if (!cita.agenda) continue
      if (especialidades.length && !especialidades.includes(cita.servicio ?? '')) continue
      const entrada = conteo.get(cita.agenda) ?? { citas: 0, especialidad: cita.servicio }
      entrada.citas++
      conteo.set(cita.agenda, entrada)
    }
    return [...conteo.entries()]
      .map(([nombre, v]): Agenda => ({
        id: nombre,
        nombre,
        citas: v.citas,
        especialidadId: v.especialidad,
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  },

  async buscarPaciente(nhc: string): Promise<PacienteEncontrado | null> {
    const buscado = normalizarNhc(nhc)
    if (!buscado) return null

    // Los pacientes del listado se pueden buscar por su historia, y además hay
    // uno que no aparece en ninguna agenda: es el caso que interesa probar.
    const deAgenda = REGISTROS.find((r) => r.etiqueta.codigoBarras === buscado)
    if (deAgenda) {
      const e = deAgenda.etiqueta
      return {
        nhc: buscado,
        nombre: e.nombre,
        fechaNacimiento: e.fechaNacimiento,
        documento: e.documento,
        aseguradora: e.aseguradora,
        poliza: e.poliza,
        telefono: e.telefono,
        direccion: e.direccion,
        poblacion: e.poblacion,
        episodio: e.episodio.split(' - ')[1],
      }
    }

    if (buscado === '00209999') {
      return {
        nhc: buscado,
        nombre: 'SIN CITA PRUEBA, PACIENTE',
        fechaNacimiento: '05/06/1975',
        documento: '99999999R',
        aseguradora: 'ASEGURADORA DEMO SA',
        poliza: '9999999990000000009',
        telefono: '600000099',
        direccion: 'CALLE SIN CITA 9',
        poblacion: 'Málaga',
        episodio: 'CC004',
        fechaEpisodio: '10/09/2026',
      }
    }

    return null
  },

  async firmaDelDia(_fecha: string): Promise<string> {
    // Los datos ficticios no cambian, así que la huella es constante.
    return `mock:${REGISTROS.length}`
  },

  async datosEtiqueta(citaId: string): Promise<DatosEtiqueta> {
    const registro = REGISTROS.find((r) => r.cita.id === citaId)
    if (!registro) throw new Error(`No existe la cita "${citaId}"`)
    return registro.etiqueta
  },
}
