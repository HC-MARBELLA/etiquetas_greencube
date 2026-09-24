import { config } from '../config.js'
import type { DatosEtiqueta } from './tipos.js'
import { campoLogoAlmacenado } from './logo.js'
import {
  ajustarAAncho,
  altoCodigoBarras,
  anchoCodigoBarras,
  anchoEstimado,
  anchoModuloQueCabe,
  campoTexto,
  codigoBarras128,
  mmAPuntos,
  normalizar,
} from './zpl.js'

const MARGEN = mmAPuntos(config.etiqueta.margenMm)
const SEPARACION_BASE = 4
const ALTURA_MINIMA = 14

/**
 * Altura de las barras, sin contar la línea de interpretación.
 *
 * El código va abajo a la derecha, donde el texto deja sitio libre, y se
 * aprovecha ese hueco para hacerlo grande: cuanto más alto y más ancho es el
 * módulo, más tolerante resulta a una lectura en mala posición o sobre un tubo
 * curvo, que es como se van a escanear estas etiquetas.
 */
const ALTURA_BARRAS = 80
/** Puntos por módulo estrecho. 3 a 203 dpi es cómodo para lectores de mano. */
const ANCHO_MODULO = 3
/** Hueco entre el bloque de texto y el código de barras. */
const HUECO_CODIGO = 14

interface Linea {
  texto: string
  alturaBase: number
}

/** Aplica `normalizar` a todos los campos de texto que vengan informados. */
function normalizarDatos(datos: DatosEtiqueta): DatosEtiqueta {
  const limpio = {} as Record<string, string>
  for (const [clave, valor] of Object.entries(datos)) {
    if (typeof valor === 'string') {
      const normalizado = normalizar(valor)
      if (normalizado) limpio[clave] = normalizado
    }
  }
  return limpio as unknown as DatosEtiqueta
}

/**
 * Construye las líneas de la etiqueta descartando las que no tienen dato.
 *
 * El orden es deliberado: lo que se busca de un vistazo en el mostrador va
 * arriba y en cuerpo grande (episodio y nombre); lo administrativo, abajo.
 * "Cama" solo aparece en hospitalización, donde viene informada.
 */
function componerLineas(datos: DatosEtiqueta): Linea[] {
  const lineas: Linea[] = [
    { texto: datos.episodio, alturaBase: 38 },
    { texto: datos.nombre, alturaBase: 30 },
  ]

  const identificacion = [datos.fechaNacimiento, datos.documento].filter(Boolean).join('   ')
  if (identificacion) lineas.push({ texto: identificacion, alturaBase: 24 })

  if (datos.aseguradora) lineas.push({ texto: datos.aseguradora, alturaBase: 23 })
  if (datos.poliza) lineas.push({ texto: `Póliza: ${datos.poliza}`, alturaBase: 22 })

  const unidad = [datos.servicio, datos.cama ? `Cama: ${datos.cama}` : undefined]
    .filter(Boolean)
    .join('    ')
  if (unidad) lineas.push({ texto: unidad, alturaBase: 26 })

  const asistencia = [
    datos.fechaAsistencia ? `Asist: ${datos.fechaAsistencia}` : undefined,
    datos.telefono ? `Tel: ${datos.telefono}` : undefined,
  ]
    .filter(Boolean)
    .join('    ')
  if (asistencia) lineas.push({ texto: asistencia, alturaBase: 22 })

  const domicilio = [datos.direccion, datos.poblacion].filter(Boolean).join(' - ')
  if (domicilio) lineas.push({ texto: domicilio, alturaBase: 21 })

  return lineas
}

/**
 * Factor de reducción a aplicar a todas las líneas para que el bloque quepa
 * en el alto disponible. Se escala el conjunto en lugar de recortar las
 * últimas líneas, para que la etiqueta siga leyéndose como una unidad.
 */
function calcularFactorVertical(lineas: Linea[], altoDisponible: number): number {
  const necesario = lineas.reduce((total, l) => total + l.alturaBase + SEPARACION_BASE, 0)
  return necesario <= altoDisponible ? 1 : altoDisponible / necesario
}

function cabecera(copias: number): string {
  const ancho = mmAPuntos(config.etiqueta.anchoMm)
  const alto = mmAPuntos(config.etiqueta.altoMm)
  const metodo = config.etiqueta.metodo === 'directa' ? 'D' : 'T'

  const partes: string[] = []

  // ~SD persiste en la impresora; solo se emite si se configura explícitamente.
  if (config.etiqueta.contraste !== undefined) {
    partes.push(`~SD${String(Math.round(config.etiqueta.contraste)).padStart(2, '0')}`)
  }

  partes.push('^XA')
  partes.push('^CI28') // UTF-8: necesario para los acentos (ENFERMERÍA, Málaga…)
  partes.push(`^MT${metodo}`) // método de impresión, independiente de lo guardado
  partes.push('^MNY') // sensor de espacio/muesca entre etiquetas
  partes.push(`^PW${ancho}`)
  partes.push(`^LL${alto}`)
  partes.push('^LH0,0')
  partes.push('^LT0')
  partes.push('^PON')

  if (config.etiqueta.velocidad !== undefined) {
    partes.push(`^PR${Math.round(config.etiqueta.velocidad)}`)
  }

  return partes.join('\n')
}

/**
 * Genera el ZPL completo de una etiqueta de paciente.
 *
 * Diseño para 100×35mm a 203 dpi (800×280 puntos): logo arriba a la izquierda,
 * bloque de texto ocupando el resto y código de barras abajo a la derecha, que
 * es la esquina que el texto deja libre. Las líneas que caen a la altura del
 * logo o del código se estrechan solas.
 */
export interface Caja {
  nombre: string
  x: number
  y: number
  ancho: number
  alto: number
}

export interface EtiquetaCompuesta {
  zpl: string
  /** Área imprimible declarada, en puntos. */
  limites: { ancho: number; alto: number }
  /** Caja de cada elemento, para poder comprobar que nada se sale. */
  cajas: Caja[]
  /** Ancho de módulo finalmente usado en el código de barras. */
  moduloCodigo: number
}

/**
 * Comprueba que ningún elemento se salga del área imprimible.
 *
 * Existe porque un Code 128 que se sale no se ve "un poco cortado": pierde el
 * dígito de control y la parada, y deja de leerse del todo. Conviene detectarlo
 * en la vista previa y no con el lector en la mano.
 */
export function verificarEncaje(etiqueta: EtiquetaCompuesta): string[] {
  const problemas: string[] = []
  const { ancho, alto } = etiqueta.limites

  for (const caja of etiqueta.cajas) {
    if (caja.x < 0 || caja.y < 0) {
      problemas.push(`${caja.nombre}: empieza fuera de la etiqueta en (${caja.x},${caja.y})`)
    }
    if (caja.x + caja.ancho > ancho) {
      problemas.push(
        `${caja.nombre}: se sale ${caja.x + caja.ancho - ancho} puntos por la derecha ` +
          `(llega a ${caja.x + caja.ancho} de ${ancho})`,
      )
    }
    if (caja.y + caja.alto > alto) {
      problemas.push(
        `${caja.nombre}: se sale ${caja.y + caja.alto - alto} puntos por abajo ` +
          `(llega a ${caja.y + caja.alto} de ${alto})`,
      )
    }
  }

  return problemas
}

export function generarEtiquetaPaciente(entrada: DatosEtiqueta, copias: number): string {
  return componerEtiqueta(entrada, copias).zpl
}

export function componerEtiqueta(entrada: DatosEtiqueta, copias: number): EtiquetaCompuesta {
  const datos = normalizarDatos(entrada)
  const ancho = mmAPuntos(config.etiqueta.anchoMm)
  const alto = mmAPuntos(config.etiqueta.altoMm)

  // El código de barras se ancla abajo a la derecha: es la zona que el bloque
  // de texto deja libre, y así las líneas largas (nombres compuestos) disponen
  // del ancho completo de la etiqueta en la parte de arriba.
  //
  // El ancho de módulo se elige en función de lo que quepa. Un Code 128 que se
  // sale del área imprimible pierde el dígito de control y deja de leerse, así
  // que antes que salirse se estrecha.
  const anchoMaximoCodigo = Math.round((ancho - MARGEN * 2) * 0.45)
  const moduloCodigo = anchoModuloQueCabe(datos.codigoBarras, anchoMaximoCodigo, ANCHO_MODULO)

  if (moduloCodigo === null) {
    throw new Error(
      `El código de barras "${datos.codigoBarras}" no cabe en la etiqueta ` +
        `(necesita ${anchoCodigoBarras(datos.codigoBarras, 2)} puntos y solo hay ${anchoMaximoCodigo}).`,
    )
  }

  const anchoCodigo = anchoCodigoBarras(datos.codigoBarras, moduloCodigo)

  // Code 128 exige una zona muda de 10 módulos a cada lado del símbolo. Sin
  // ella el lector no encuentra dónde empieza y falla de forma intermitente,
  // aunque el código esté impreso entero.
  const zonaMuda = moduloCodigo * 10
  const xCodigo = ancho - Math.max(MARGEN, zonaMuda) - anchoCodigo
  const yCodigo = alto - MARGEN - altoCodigoBarras(ALTURA_BARRAS)

  // El logo, cuando está cargado, ocupa la esquina superior izquierda y
  // desplaza hacia la derecha las líneas que quedan a su altura.
  const conLogo = config.etiqueta.logo !== '' && config.etiqueta.logoAnchoPt > 0
  const finLogo = conLogo ? MARGEN + config.etiqueta.logoAltoPt : 0
  const sangriaLogo = conLogo ? config.etiqueta.logoAnchoPt + HUECO_CODIGO : 0

  const lineas = componerLineas(datos)
  const factor = calcularFactorVertical(lineas, alto - MARGEN * 2)

  const cuerpo: string[] = []
  const cajas: Caja[] = [
    {
      nombre: 'código de barras',
      x: xCodigo,
      y: yCodigo,
      ancho: anchoCodigo,
      alto: altoCodigoBarras(ALTURA_BARRAS),
    },
  ]

  if (conLogo) {
    cajas.push({
      nombre: 'logo',
      x: MARGEN,
      y: MARGEN,
      ancho: config.etiqueta.logoAnchoPt,
      alto: config.etiqueta.logoAltoPt,
    })
  }

  let y = MARGEN

  for (const linea of lineas) {
    const altura = Math.max(ALTURA_MINIMA, Math.round(linea.alturaBase * factor))

    // Una línea se estrecha si cae a la altura del logo (por la izquierda) o
    // si invade la franja del código de barras (por la derecha).
    const x = MARGEN + (y < finLogo ? sangriaLogo : 0)
    const invadeCodigo = y + altura > yCodigo
    // Por la izquierda el código necesita la misma zona muda que por la derecha.
    const limiteDerecho = invadeCodigo
      ? xCodigo - Math.max(HUECO_CODIGO, zonaMuda)
      : ancho - MARGEN
    const ajustada = ajustarAAncho(linea.texto, altura, limiteDerecho - x, ALTURA_MINIMA)

    cuerpo.push(campoTexto(x, y, ajustada.altura, ajustada.texto))
    cajas.push({
      nombre: `texto "${ajustada.texto.slice(0, 24)}"`,
      x,
      y,
      ancho: Math.round(anchoEstimado(ajustada.texto, ajustada.altura)),
      alto: ajustada.altura,
    })

    y += ajustada.altura + Math.max(2, Math.round(SEPARACION_BASE * factor))
  }

  const zpl = [
    cabecera(copias),
    ...(conLogo ? [campoLogoAlmacenado(MARGEN, MARGEN, config.etiqueta.logo)] : []),
    codigoBarras128(xCodigo, yCodigo, ALTURA_BARRAS, datos.codigoBarras, moduloCodigo),
    ...cuerpo,
    `^PQ${copias},0,0,N`,
    '^XZ',
    '',
  ].join('\n')

  return { zpl, limites: { ancho, alto }, cajas, moduloCodigo }
}

/**
 * Etiqueta de prueba con datos inventados, para validar medidas, contraste y
 * lectura del código de barras sin usar datos de un paciente real.
 */
export function datosDePrueba(): DatosEtiqueta {
  return {
    episodio: '00000001 - PR001',
    codigoBarras: '00000001',
    nombre: 'PRUEBA DE IMPRESIÓN ÁÉÍÓÚ',
    fechaNacimiento: '01/01/1970',
    documento: 'X0000000T',
    aseguradora: 'ASEGURADORA DE PRUEBA',
    poliza: '0000000000000000000',
    servicio: 'ENFERMERÍA',
    fechaAsistencia: '01/01/2026 00:00',
    direccion: 'CALLE DE PRUEBA 1',
    poblacion: 'Málaga',
  }
}
