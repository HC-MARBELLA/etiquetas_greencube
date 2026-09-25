const $ = (s) => document.querySelector(s)

const el = {
  fecha: $('#fecha'),
  especialidad: $('#especialidad'),
  multiAgenda: $('#multi-agenda'),
  agendaBoton: $('#agenda-boton'),
  agendaTexto: $('#agenda-texto'),
  agendaPanel: $('#agenda-panel'),
  agendaFiltro: $('#agenda-filtro'),
  agendaLista: $('#agenda-lista'),
  agendaTodas: $('#agenda-todas'),
  agendaNinguna: $('#agenda-ninguna'),
  buscar: $('#buscar'),
  copiasDefecto: $('#copias-defecto'),
  campoImpresora: $('#campo-impresora'),
  impresora: $('#impresora'),
  ocultarImpresas: $('#ocultar-impresas'),
  desdeAhora: $('#desde-ahora'),
  conmutadorAhora: $('#conmutador-ahora'),
  limpiar: $('#limpiar'),
  recargar: $('#recargar'),
  filas: $('#filas'),
  vacio: $('#vacio'),
  vacioTexto: $('#vacio-texto'),
  resumen: $('#resumen'),
  porPagina: $('#por-pagina'),
  paginacion: $('#paginacion'),
  rango: $('#rango'),
  primera: $('#primera'),
  anterior: $('#anterior'),
  siguiente: $('#siguiente'),
  ultima: $('#ultima'),
  paginas: $('#paginas'),
  origen: $('#origen'),
  actualizado: $('#actualizado'),
  luz: $('#luz'),
  textoImpresora: $('#texto-impresora'),
  listaVistas: $('#lista-vistas'),
  guardarVista: $('#guardar-vista'),
  aviso: $('#aviso'),

  // Modal de paciente sin cita
  abrirBuscador: $('#abrir-buscador'),
  modal: $('#modal'),
  modalCerrar: $('#modal-cerrar'),
  formBuscar: $('#form-buscar'),
  nhc: $('#nhc'),
  btnBuscar: $('#btn-buscar'),
  modalError: $('#modal-error'),
  ficha: $('#ficha'),
  fichaNombre: $('#ficha-nombre'),
  fichaNhc: $('#ficha-nhc'),
  fichaImpresas: $('#ficha-impresas'),
  fichaDatos: $('#ficha-datos'),
  modalCopias: $('#modal-copias'),
  copiasMenos: $('#copias-menos'),
  copiasMas: $('#copias-mas'),
  btnImprimir: $('#btn-imprimir'),
}

let ajustes = { copiasPorDefecto: 3, copiasMaximas: 20, refrescoSegundos: 25, impresoras: [] }
let citas = []
let vistas = []
let vistaActiva = null
let pagina = 1
let ultimaConsulta = null
let temporizadorAviso
let recargando = false

/** Agendas del día disponibles para elegir, y las que están marcadas. */
let agendasDisponibles = []
let agendasElegidas = new Set()
let temporizadorAgendas

const hoyLocal = () => new Date().toLocaleDateString('sv-SE')

const PREFERENCIAS = 'etiquetas.preferencias'

/**
 * Minutos hacia atrás que sigue mostrando "Desde ahora".
 *
 * Un paciente que llega tarde a su cita de las 10:00 sigue necesitando sus
 * etiquetas a las 10:20; si el corte fuese exacto desaparecería del listado
 * justo cuando hace falta.
 */
const MARGEN_RETRASO_MIN = 45

const esHoy = () => el.fecha.value === hoyLocal()

/**
 * Preferencias del puesto, en el navegador.
 *
 * Se guardan los filtros de trabajo (especialidad, agenda, etiquetas por
 * defecto, conmutadores) pero **nunca la fecha**: al abrir por la mañana se
 * quiere el día de hoy, no el último que se miró.
 */
function guardarPreferencias() {
  try {
    localStorage.setItem(
      PREFERENCIAS,
      JSON.stringify({
        especialidad: el.especialidad.value,
        agendas: [...agendasElegidas],
        copias: el.copiasDefecto.value,
        impresora: el.impresora.value,
        ocultarImpresas: el.ocultarImpresas.checked,
        desdeAhora: el.desdeAhora.checked,
        porPagina: el.porPagina.value,
        vistaActiva,
      }),
    )
  } catch {
    // Modo privado o almacenamiento lleno: se sigue sin recordar nada.
  }
}

function leerPreferencias() {
  try {
    return JSON.parse(localStorage.getItem(PREFERENCIAS) ?? '{}')
  } catch {
    return {}
  }
}

function avisar(mensaje, esError = false) {
  clearTimeout(temporizadorAviso)
  el.aviso.textContent = mensaje
  el.aviso.classList.toggle('error', esError)
  el.aviso.hidden = false
  temporizadorAviso = setTimeout(() => { el.aviso.hidden = true }, esError ? 7000 : 3200)
}

async function pedir(url, opciones) {
  const respuesta = await fetch(url, opciones)
  const cuerpo = await respuesta.json().catch(() => ({}))
  if (!respuesta.ok) throw new Error(cuerpo.error ?? `Error ${respuesta.status}`)
  return cuerpo
}

function impresoraActiva() {
  return (
    ajustes.impresoras.find((i) => i.id === el.impresora.value) ??
    ajustes.impresoras.find((i) => i.predeterminada) ??
    ajustes.impresoras[0]
  )
}

function copiasPorDefecto() {
  const n = Number(el.copiasDefecto.value)
  return Number.isInteger(n) && n >= 1 && n <= ajustes.copiasMaximas ? n : ajustes.copiasPorDefecto
}

/** Un cambio manual de filtros ya no corresponde a la vista guardada. */
function soltarVista() {
  if (vistaActiva === null) return
  vistaActiva = null
  pintarVistas()
  guardarPreferencias()
}

// ---------- Impresora ----------

async function comprobarImpresora() {
  const impresora = impresoraActiva()
  if (!impresora) return
  try {
    const estado = await pedir(`/api/impresoras/${impresora.id}/estado`)
    if (!estado.accesible) {
      el.luz.className = 'luz error'
      el.textoImpresora.textContent = `${impresora.nombre}: no responde`
    } else if (estado.sinPapel || estado.cabezalAbierto) {
      el.luz.className = 'luz error'
      el.textoImpresora.textContent = `${impresora.nombre}: ${
        estado.sinPapel ? 'sin etiquetas' : 'cabezal abierto'
      }`
    } else {
      el.luz.className = 'luz ok'
      el.textoImpresora.textContent = `${impresora.nombre} · lista`
    }
  } catch (e) {
    el.luz.className = 'luz error'
    el.textoImpresora.textContent = e.message
  }
}

// ---------- Listado ----------

/** Minutos desde medianoche de una hora "HH:MM". */
function enMinutos(hora) {
  const [h, m] = hora.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function citasFiltradas() {
  const texto = el.buscar.value.trim().toLowerCase()

  // El corte por hora solo tiene sentido en el día de hoy.
  const corte =
    el.desdeAhora.checked && esHoy()
      ? enMinutos(new Date().toTimeString().slice(0, 5)) - MARGEN_RETRASO_MIN
      : null

  return citas.filter((c) => {
    if (el.ocultarImpresas.checked && c.impresiones) return false
    if (corte !== null && enMinutos(c.hora) < corte) return false
    if (!texto) return true
    return c.paciente.toLowerCase().includes(texto) || c.episodio.toLowerCase().includes(texto)
  })
}

/** El conmutador de hora se apaga visualmente cuando no se mira el día de hoy. */
function ajustarConmutadorAhora() {
  const aplicable = esHoy()
  el.desdeAhora.disabled = !aplicable
  el.conmutadorAhora.classList.toggle('inactivo', !aplicable)
  el.conmutadorAhora.title = aplicable
    ? `Oculta las citas de hace más de ${MARGEN_RETRASO_MIN} minutos`
    : 'Solo se aplica al día de hoy'
}

function crearContador() {
  const caja = document.createElement('div')
  caja.className = 'contador'

  const menos = document.createElement('button')
  menos.type = 'button'
  menos.textContent = '−'
  menos.setAttribute('aria-label', 'Una etiqueta menos')

  const campo = document.createElement('input')
  campo.type = 'number'
  campo.min = '1'
  campo.max = String(ajustes.copiasMaximas)
  campo.value = String(copiasPorDefecto())
  campo.setAttribute('aria-label', 'Número de etiquetas')

  const mas = document.createElement('button')
  mas.type = 'button'
  mas.textContent = '+'
  mas.setAttribute('aria-label', 'Una etiqueta más')

  const mover = (d) => {
    const actual = Number(campo.value) || copiasPorDefecto()
    campo.value = String(Math.min(ajustes.copiasMaximas, Math.max(1, actual + d)))
  }
  menos.addEventListener('click', () => mover(-1))
  mas.addEventListener('click', () => mover(1))

  caja.append(menos, campo, mas)
  return { caja, campo }
}

function celda(contenido, clase) {
  const td = document.createElement('td')
  if (clase) td.className = clase
  if (contenido instanceof Node) td.append(contenido)
  else td.textContent = contenido
  return td
}

/** Minutos desde medianoche, ahora mismo. */
function minutosAhora() {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * Fila separadora que marca la hora actual, al estilo de la línea de "ahora"
 * de un calendario. Da la referencia de por dónde va el mostrador sin tener
 * que mirar el reloj y comparar.
 */
function crearMarcadorAhora() {
  const tr = document.createElement('tr')
  tr.className = 'marcador-ahora'

  const td = document.createElement('td')
  td.colSpan = 6

  const linea = document.createElement('div')
  linea.className = 'linea-ahora'

  const etiqueta = document.createElement('span')
  etiqueta.className = 'linea-ahora-hora'
  etiqueta.textContent = new Date().toTimeString().slice(0, 5)

  const trazo = document.createElement('span')
  trazo.className = 'linea-ahora-trazo'

  linea.append(etiqueta, trazo)
  td.append(linea)
  tr.append(td)
  return tr
}

function crearFila(cita, pasada) {
  const tr = document.createElement('tr')
  const clases = []
  if (cita.impresiones) clases.push('impresa')
  if (pasada) clases.push('pasada')
  tr.className = clases.join(' ')

  const [historia] = cita.episodio.split(' - ')

  tr.append(celda(cita.hora, 'hora'))
  tr.append(celda(cita.paciente, 'paciente'))
  tr.append(celda(historia, 'historia'))
  tr.append(celda(cita.agenda ?? cita.servicio ?? '', 'agenda-celda'))

  // Estado
  if (cita.impresiones) {
    const chip = document.createElement('span')
    chip.className = 'chip chip-ok'
    const { copias, veces, ultima } = cita.impresiones
    chip.textContent =
      `${copias} etiqueta${copias === 1 ? '' : 's'} · ${ultima}` + (veces > 1 ? ` · ${veces} envíos` : '')
    tr.append(celda(chip))
  } else {
    tr.append(celda('Sin imprimir', 'sin-imprimir'))
  }

  // Acción
  const acciones = document.createElement('div')
  acciones.className = 'acciones-celda'
  const { caja, campo } = crearContador()

  const boton = document.createElement('button')
  boton.type = 'button'
  boton.className = cita.impresiones ? 'btn btn-suave btn-chico' : 'btn btn-principal btn-chico'
  boton.textContent = cita.impresiones ? 'Reimprimir' : 'Imprimir'

  boton.addEventListener('click', async () => {
    const copias = Number(campo.value)
    boton.disabled = true
    const previo = boton.textContent
    boton.textContent = 'Enviando…'
    try {
      const r = await pedir('/api/imprimir', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          citaId: cita.id,
          copias,
          fecha: el.fecha.value,
          impresoraId: impresoraActiva()?.id,
        }),
      })
      avisar(`${r.copias} etiqueta${r.copias === 1 ? '' : 's'} enviada${r.copias === 1 ? '' : 's'} a ${r.impresora}`)
      cita.impresiones = r.impresiones
      pintar()
    } catch (e) {
      avisar(e.message, true)
      comprobarImpresora()
      boton.disabled = false
      boton.textContent = previo
    }
  })

  acciones.append(caja, boton)
  tr.append(celda(acciones, 'col-accion'))
  return tr
}

function pintarPaginacion(total, paginas) {
  el.paginacion.hidden = total === 0

  el.primera.disabled = pagina === 1
  el.anterior.disabled = pagina === 1
  el.siguiente.disabled = pagina >= paginas
  el.ultima.disabled = pagina >= paginas

  // Ventana de páginas alrededor de la actual, con elipsis a los lados.
  const numeros = []
  const ventana = 1
  for (let p = 1; p <= paginas; p++) {
    if (p === 1 || p === paginas || Math.abs(p - pagina) <= ventana) numeros.push(p)
    else if (numeros[numeros.length - 1] !== '…') numeros.push('…')
  }

  el.paginas.replaceChildren(
    ...numeros.map((n) => {
      if (n === '…') {
        const s = document.createElement('span')
        s.className = 'elipsis'
        s.textContent = '…'
        return s
      }
      const b = document.createElement('button')
      b.type = 'button'
      b.className = n === pagina ? 'btn btn-pagina actual' : 'btn btn-pagina'
      b.textContent = String(n)
      b.addEventListener('click', () => { pagina = n; pintar() })
      return b
    }),
  )
}

function pintar() {
  const visibles = citasFiltradas()
  const porPagina = Number(el.porPagina.value)
  const paginas = Math.max(1, Math.ceil(visibles.length / porPagina))

  if (pagina > paginas) pagina = paginas

  const desde = (pagina - 1) * porPagina
  const enPagina = visibles.slice(desde, desde + porPagina)

  // Solo tiene sentido situar el "ahora" en el día de hoy.
  const ahora = esHoy() ? minutosAhora() : null

  // El límite se calcula sobre la lista completa, no sobre la página: si se
  // mirase solo la página, toda página que empiece con una cita futura
  // pintaría su propio marcador y saldrían varios.
  let limite = -1
  if (ahora !== null) {
    const encontrado = visibles.findIndex((c) => enMinutos(c.hora) >= ahora)
    limite = encontrado === -1 ? visibles.length : encontrado
  }

  const nodos = []
  for (let i = 0; i < enPagina.length; i++) {
    const indiceGlobal = desde + i
    if (indiceGlobal === limite) nodos.push(crearMarcadorAhora())
    const cita = enPagina[i]
    nodos.push(crearFila(cita, ahora !== null && enMinutos(cita.hora) < ahora))
  }

  // Si ya pasaron todas, el marcador cierra la última página.
  const finDeLista = desde + enPagina.length === visibles.length
  if (limite === visibles.length && finDeLista && enPagina.length > 0) {
    nodos.push(crearMarcadorAhora())
  }

  el.filas.replaceChildren(...nodos)

  const impresas = citas.filter((c) => c.impresiones).length
  el.resumen.replaceChildren()
  const total = document.createElement('span')
  total.innerHTML = `<strong>${citas.length}</strong> cita${citas.length === 1 ? '' : 's'}`
  el.resumen.append(total)
  if (impresas > 0) {
    const hechas = document.createElement('span')
    hechas.innerHTML = `· <strong>${impresas}</strong> ya impresa${impresas === 1 ? '' : 's'}`
    el.resumen.append(hechas)
  }
  if (visibles.length !== citas.length) {
    const filtradas = document.createElement('span')
    filtradas.innerHTML = `· <strong>${visibles.length}</strong> tras filtros`
    el.resumen.append(filtradas)
  }

  el.vacio.hidden = visibles.length > 0
  el.vacioTexto.textContent =
    citas.length === 0
      ? 'No hay citas para esta fecha con los filtros elegidos.'
      : 'Ninguna cita coincide con la búsqueda.'

  el.rango.textContent = visibles.length
    ? `${desde + 1}–${Math.min(desde + porPagina, visibles.length)} de ${visibles.length}`
    : ''

  ajustarConmutadorAhora()
  pintarPaginacion(visibles.length, paginas)
}

function mostrarAntiguedad() {
  if (!ultimaConsulta) return
  const s = Math.round((Date.now() - ultimaConsulta) / 1000)
  el.actualizado.textContent = s < 5 ? 'actualizado ahora' : `actualizado hace ${s} s`
}

function parametrosActuales() {
  const p = new URLSearchParams({ fecha: el.fecha.value })
  if (el.especialidad.value) p.set('especialidad', el.especialidad.value)
  // Ninguna marcada equivale a todas: así el listado nunca sale vacío por
  // haber desmarcado sin querer la única que quedaba.
  if (agendasElegidas.size > 0) p.set('agenda', [...agendasElegidas].join(','))
  return p
}

async function cargarAgenda({ silencioso = false } = {}) {
  if (recargando) return
  recargando = true
  try {
    const datos = await pedir(`/api/agenda?${parametrosActuales()}`)
    citas = datos.citas
    ultimaConsulta = Date.now()
    pintar()
    mostrarAntiguedad()
  } catch (e) {
    if (!silencioso) {
      citas = []
      pintar()
      avisar(e.message, true)
    }
  } finally {
    recargando = false
  }
}

function rellenarSelect(select, opciones, textoTodas) {
  const previo = select.value
  select.replaceChildren(new Option(textoTodas, ''))
  for (const o of opciones) {
    select.append(new Option(o.citas ? `${o.nombre} (${o.citas})` : o.nombre, o.id))
  }
  select.value = opciones.some((o) => o.id === previo) ? previo : ''
}

// ---------- Selector múltiple de agendas ----------

function textoAgendas() {
  if (agendasElegidas.size === 0) return 'Todas las agendas'
  if (agendasElegidas.size === 1) {
    const [id] = agendasElegidas
    return agendasDisponibles.find((a) => a.id === id)?.nombre ?? id
  }
  return `${agendasElegidas.size} agendas`
}

function pintarSelectorAgendas() {
  const filtro = el.agendaFiltro.value.trim().toLowerCase()
  const visibles = filtro
    ? agendasDisponibles.filter((a) => a.nombre.toLowerCase().includes(filtro))
    : agendasDisponibles

  if (visibles.length === 0) {
    const vacio = document.createElement('p')
    vacio.className = 'multi-vacio'
    vacio.textContent = agendasDisponibles.length
      ? 'Ninguna agenda coincide.'
      : 'No hay agendas este día.'
    el.agendaLista.replaceChildren(vacio)
  } else {
    el.agendaLista.replaceChildren(
      ...visibles.map((a) => {
        const fila = document.createElement('label')
        fila.className = 'multi-opcion'

        const casilla = document.createElement('input')
        casilla.type = 'checkbox'
        casilla.checked = agendasElegidas.has(a.id)
        casilla.addEventListener('change', () => {
          if (casilla.checked) agendasElegidas.add(a.id)
          else agendasElegidas.delete(a.id)
          alCambiarAgendas()
        })

        const texto = document.createElement('span')
        texto.className = 'multi-opcion-texto'
        texto.textContent = a.nombre
        texto.title = a.nombre

        fila.append(casilla, texto)

        if (a.citas) {
          const conteo = document.createElement('span')
          conteo.className = 'multi-opcion-conteo'
          conteo.textContent = String(a.citas)
          fila.append(conteo)
        }

        return fila
      }),
    )
  }

  el.agendaTexto.textContent = textoAgendas()
  el.agendaBoton.classList.toggle('con-seleccion', agendasElegidas.size > 0)
}

/**
 * Marcar varias casillas seguidas no debe lanzar una consulta por clic, así
 * que se agrupan y se consulta una sola vez cuando el usuario para.
 */
function alCambiarAgendas() {
  soltarVista()
  pagina = 1
  pintarSelectorAgendas()
  guardarPreferencias()
  clearTimeout(temporizadorAgendas)
  temporizadorAgendas = setTimeout(() => cargarAgenda(), 350)
}

function abrirSelectorAgendas(abrir) {
  el.agendaPanel.hidden = !abrir
  el.agendaBoton.setAttribute('aria-expanded', String(abrir))
  if (abrir) {
    el.agendaFiltro.value = ''
    pintarSelectorAgendas()
    el.agendaFiltro.focus()
  }
}

async function cargarEspecialidades() {
  try {
    const { especialidades } = await pedir(`/api/especialidades?fecha=${el.fecha.value}`)
    rellenarSelect(el.especialidad, especialidades, 'Todas las especialidades')
  } catch { /* el filtro se queda como esté */ }
}

async function cargarAgendas() {
  try {
    const p = new URLSearchParams({ fecha: el.fecha.value })
    if (el.especialidad.value) p.set('especialidad', el.especialidad.value)
    const { agendas } = await pedir(`/api/agendas?${p}`)
    agendasDisponibles = agendas

    // Al cambiar de día o de especialidad, las agendas marcadas pueden dejar
    // de existir. Se descartan en vez de filtrar por algo que ya no está.
    const validas = new Set(agendas.map((a) => a.id))
    for (const id of [...agendasElegidas]) if (!validas.has(id)) agendasElegidas.delete(id)

    pintarSelectorAgendas()
  } catch { /* idem */ }
}

// ---------- Vistas guardadas ----------

async function aplicarVista(v) {
  el.especialidad.value = v.especialidad ?? ''
  agendasElegidas = new Set(v.agendas)
  await cargarAgendas()
  if (v.copias) el.copiasDefecto.value = String(v.copias)
  if (v.impresoraId && ajustes.impresoras.some((i) => i.id === v.impresoraId)) {
    el.impresora.value = v.impresoraId
  }
  el.ocultarImpresas.checked = Boolean(v.ocultarImpresas)

  vistaActiva = v.id
  pagina = 1
  pintarVistas()
  guardarPreferencias()
  await Promise.all([cargarAgenda(), comprobarImpresora()])
}

function pintarVistas() {
  el.listaVistas.replaceChildren(
    ...vistas.map((v) => {
      const grupo = document.createElement('span')
      grupo.className = v.id === vistaActiva ? 'vista activa' : 'vista'

      const aplicar = document.createElement('button')
      aplicar.type = 'button'
      aplicar.className = 'vista-aplicar'
      aplicar.textContent = v.nombre
      aplicar.title = [
        v.agendas.length ? `Agenda: ${v.agendas.join(', ')}` : 'Todas las agendas',
        v.copias ? `${v.copias} etiquetas` : null,
        v.ocultarImpresas ? 'Oculta las ya impresas' : null,
      ].filter(Boolean).join(' · ')
      aplicar.addEventListener('click', () => aplicarVista(v))

      const borrar = document.createElement('button')
      borrar.type = 'button'
      borrar.className = 'vista-borrar'
      borrar.textContent = '×'
      borrar.title = `Borrar la vista "${v.nombre}"`
      borrar.addEventListener('click', async () => {
        if (!confirm(`¿Borrar la vista "${v.nombre}"?`)) return
        try {
          const r = await pedir(`/api/vistas/${v.id}`, { method: 'DELETE' })
          vistas = r.vistas
          if (vistaActiva === v.id) vistaActiva = null
          pintarVistas()
        } catch (e) { avisar(e.message, true) }
      })

      grupo.append(aplicar, borrar)
      return grupo
    }),
  )
}

async function cargarVistas() {
  try {
    vistas = (await pedir('/api/vistas')).vistas
    pintarVistas()
  } catch { /* sin vistas, sin drama */ }
}

// ---------- Modal de paciente sin cita ----------

let pacienteEncontrado = null

function errorModal(mensaje) {
  el.modalError.textContent = mensaje ?? ''
  el.modalError.hidden = !mensaje
}

function limpiarFicha() {
  pacienteEncontrado = null
  el.ficha.hidden = true
  el.fichaImpresas.hidden = true
  el.fichaDatos.replaceChildren()
}

function abrirModal(abrir) {
  el.modal.hidden = !abrir
  if (abrir) {
    el.nhc.value = ''
    errorModal(null)
    limpiarFicha()
    // Foco inmediato: en el mostrador se teclea la historia nada más abrir.
    el.nhc.focus()
  } else {
    el.abrirBuscador.focus()
  }
}

function dato(termino, valor) {
  if (!valor) return
  const dt = document.createElement('dt')
  dt.textContent = termino
  const dd = document.createElement('dd')
  dd.textContent = valor
  el.fichaDatos.append(dt, dd)
}

function pintarFicha(p) {
  pacienteEncontrado = p

  el.fichaNombre.textContent = p.nombre
  el.fichaNhc.textContent = p.episodio ? `${p.nhc} · ${p.episodio}` : p.nhc

  el.fichaDatos.replaceChildren()
  dato('Nacimiento', p.fechaNacimiento)
  dato('Documento', p.documento)
  dato('Aseguradora', p.aseguradora)
  dato('Nº Póliza', p.poliza)
  dato('Teléfono', p.telefono)
  dato('Domicilio', [p.direccion, p.poblacion].filter(Boolean).join(' · '))
  if (p.episodio) dato('Último episodio', [p.episodio, p.fechaEpisodio].filter(Boolean).join(' · '))

  // Aviso de que ya se le imprimió hoy: evita duplicar cuando el paciente
  // vuelve al mostrador al rato.
  if (p.impresiones) {
    const { copias, veces, ultima } = p.impresiones
    el.fichaImpresas.textContent =
      `Ya ${veces > 1 ? 'se le imprimieron' : 'se le imprimió'} ${copias} hoy · ${ultima}`
    el.fichaImpresas.hidden = false
  } else {
    el.fichaImpresas.hidden = true
  }

  el.modalCopias.value = String(ajustes.copiasPacienteSuelto ?? 12)
  el.ficha.hidden = false
}

async function buscarPaciente() {
  const texto = el.nhc.value.trim()
  if (!texto) return

  errorModal(null)
  limpiarFicha()
  el.btnBuscar.disabled = true
  el.btnBuscar.textContent = 'Buscando…'

  try {
    pintarFicha(await pedir(`/api/pacientes/${encodeURIComponent(texto)}`))
  } catch (e) {
    errorModal(e.message)
    el.nhc.select()
  } finally {
    el.btnBuscar.disabled = false
    el.btnBuscar.textContent = 'Buscar'
  }
}

async function imprimirPaciente() {
  if (!pacienteEncontrado) return

  const copias = Number(el.modalCopias.value)
  el.btnImprimir.disabled = true
  const previo = el.btnImprimir.textContent
  el.btnImprimir.textContent = 'Enviando…'

  try {
    const r = await pedir('/api/imprimir/paciente', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nhc: pacienteEncontrado.nhc,
        copias,
        impresoraId: impresoraActiva()?.id,
      }),
    })
    avisar(`${r.copias} etiquetas de ${pacienteEncontrado.nombre} enviadas a ${r.impresora}`)

    // Se deja listo para el siguiente paciente sin cerrar el modal: en el
    // mostrador suelen venir varios seguidos.
    el.nhc.value = ''
    limpiarFicha()
    el.nhc.focus()

    // Puede estar también en la agenda del día: se refresca para que la fila
    // aparezca marcada como impresa.
    cargarAgenda({ silencioso: true })
  } catch (e) {
    errorModal(e.message)
    comprobarImpresora()
  } finally {
    el.btnImprimir.disabled = false
    el.btnImprimir.textContent = previo
  }
}

function prepararModal() {
  el.abrirBuscador.addEventListener('click', () => abrirModal(true))
  el.modalCerrar.addEventListener('click', () => abrirModal(false))

  // Cerrar pulsando el fondo, pero no al pulsar dentro del cuadro.
  el.modal.addEventListener('click', (ev) => {
    if (ev.target === el.modal) abrirModal(false)
  })

  el.formBuscar.addEventListener('submit', (ev) => {
    ev.preventDefault()
    buscarPaciente()
  })

  // Solo dígitos: el número de historia no tiene letras y así se evita
  // teclear de más con el lector de códigos.
  el.nhc.addEventListener('input', () => {
    const limpio = el.nhc.value.replace(/\D/g, '')
    if (limpio !== el.nhc.value) el.nhc.value = limpio
  })

  const mover = (d) => {
    const max = ajustes.copiasMaximas ?? 30
    const actual = Number(el.modalCopias.value) || (ajustes.copiasPacienteSuelto ?? 12)
    el.modalCopias.value = String(Math.min(max, Math.max(1, actual + d)))
  }
  el.copiasMenos.addEventListener('click', () => mover(-1))
  el.copiasMas.addEventListener('click', () => mover(1))

  el.btnImprimir.addEventListener('click', imprimirPaciente)

  document.addEventListener('keydown', (ev) => {
    if (el.modal.hidden) return
    if (ev.key === 'Escape') abrirModal(false)
    // Enter sobre la ficha imprime: evita tener que ir al ratón.
    if (ev.key === 'Enter' && pacienteEncontrado && document.activeElement !== el.nhc) {
      ev.preventDefault()
      imprimirPaciente()
    }
  })
}

// ---------- Arranque ----------

async function iniciar() {
  el.fecha.value = hoyLocal()

  ajustes = await pedir('/api/config')
  el.origen.textContent = 'datos de prueba'
  el.origen.hidden = ajustes.origenDatos !== 'mock'
  el.copiasDefecto.value = String(ajustes.copiasPorDefecto)
  el.copiasDefecto.max = String(ajustes.copiasMaximas)

  el.impresora.replaceChildren(
    ...ajustes.impresoras.map((i) => new Option(i.nombre, i.id, i.predeterminada, i.predeterminada)),
  )
  // Con una sola impresora el selector solo añade ruido.
  el.campoImpresora.hidden = ajustes.impresoras.length < 2

  // Se restauran las preferencias antes de consultar, para no pedir dos veces.
  const guardadas = leerPreferencias()
  if (guardadas.copias) el.copiasDefecto.value = guardadas.copias
  if (guardadas.porPagina) el.porPagina.value = guardadas.porPagina
  el.ocultarImpresas.checked = Boolean(guardadas.ocultarImpresas)
  el.desdeAhora.checked = Boolean(guardadas.desdeAhora)
  if (guardadas.impresora && ajustes.impresoras.some((i) => i.id === guardadas.impresora)) {
    el.impresora.value = guardadas.impresora
  }

  await Promise.all([cargarEspecialidades(), cargarVistas()])
  // La especialidad debe estar puesta antes de pedir sus agendas.
  if (guardadas.especialidad) el.especialidad.value = guardadas.especialidad
  if (Array.isArray(guardadas.agendas)) agendasElegidas = new Set(guardadas.agendas)
  await cargarAgendas()
  if (guardadas.vistaActiva && vistas.some((v) => v.id === guardadas.vistaActiva)) {
    vistaActiva = guardadas.vistaActiva
    pintarVistas()
  }

  await Promise.all([cargarAgenda(), comprobarImpresora()])

  el.fecha.addEventListener('change', async () => {
    soltarVista()
    pagina = 1
    await Promise.all([cargarEspecialidades(), cargarAgendas()])
    await cargarAgenda()
  })

  el.especialidad.addEventListener('change', async () => {
    soltarVista()
    pagina = 1
    // Al acotar la especialidad, la agenda elegida puede dejar de existir.
    await cargarAgendas()
    await cargarAgenda()
  })

  el.agendaBoton.addEventListener('click', () => {
    abrirSelectorAgendas(el.agendaPanel.hidden)
  })
  el.agendaFiltro.addEventListener('input', pintarSelectorAgendas)
  el.agendaTodas.addEventListener('click', () => {
    // "Todas" marca solo las visibles con el filtro puesto, que es lo que se
    // está viendo y por tanto lo que se espera que haga.
    const filtro = el.agendaFiltro.value.trim().toLowerCase()
    for (const a of agendasDisponibles) {
      if (!filtro || a.nombre.toLowerCase().includes(filtro)) agendasElegidas.add(a.id)
    }
    alCambiarAgendas()
  })
  el.agendaNinguna.addEventListener('click', () => {
    agendasElegidas.clear()
    alCambiarAgendas()
  })

  // Cerrar al pulsar fuera o con Escape.
  document.addEventListener('click', (ev) => {
    if (!el.agendaPanel.hidden && !el.multiAgenda.contains(ev.target)) abrirSelectorAgendas(false)
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !el.agendaPanel.hidden) {
      abrirSelectorAgendas(false)
      el.agendaBoton.focus()
    }
  })

  el.impresora.addEventListener('change', () => { soltarVista(); comprobarImpresora() })
  el.copiasDefecto.addEventListener('change', () => { soltarVista(); pintar() })
  el.ocultarImpresas.addEventListener('change', () => { soltarVista(); pagina = 1; pintar() })
  el.desdeAhora.addEventListener('change', () => { soltarVista(); pagina = 1; pintar() })
  el.porPagina.addEventListener('change', () => { pagina = 1; pintar() })
  el.buscar.addEventListener('input', () => { pagina = 1; pintar() })
  el.recargar.addEventListener('click', () => cargarAgenda())

  // Cualquier cambio de filtros se recuerda para la próxima vez que se abra.
  for (const campo of [
    el.especialidad, el.copiasDefecto, el.impresora,
    el.ocultarImpresas, el.desdeAhora, el.porPagina,
  ]) {
    campo.addEventListener('change', guardarPreferencias)
  }

  el.limpiar.addEventListener('click', async () => {
    soltarVista()
    el.fecha.value = hoyLocal()
    el.especialidad.value = ''
    agendasElegidas.clear()
    el.buscar.value = ''
    el.ocultarImpresas.checked = false
    el.desdeAhora.checked = false
    el.copiasDefecto.value = String(ajustes.copiasPorDefecto)
    pagina = 1
    guardarPreferencias()
    await Promise.all([cargarEspecialidades(), cargarAgendas()])
    await cargarAgenda()
  })

  el.primera.addEventListener('click', () => { pagina = 1; pintar() })
  el.anterior.addEventListener('click', () => { pagina = Math.max(1, pagina - 1); pintar() })
  el.siguiente.addEventListener('click', () => { pagina += 1; pintar() })
  el.ultima.addEventListener('click', () => { pagina = Number.MAX_SAFE_INTEGER; pintar() })

  el.guardarVista.addEventListener('click', async () => {
    const sugerido = vistas.find((v) => v.id === vistaActiva)?.nombre ?? ''
    const nombre = prompt('Nombre de la vista (p.ej. "Extracciones mañana")', sugerido)
    if (!nombre?.trim()) return
    try {
      const r = await pedir('/api/vistas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nombre: nombre.trim(),
          agendas: [...agendasElegidas],
          especialidad: el.especialidad.value || null,
          copias: copiasPorDefecto(),
          impresoraId: impresoraActiva()?.id,
          ocultarImpresas: el.ocultarImpresas.checked,
        }),
      })
      vistas = r.vistas
      vistaActiva = vistas.find((v) => v.nombre === nombre.trim())?.id ?? null
      pintarVistas()
      avisar(`Vista "${nombre.trim()}" guardada`)
    } catch (e) { avisar(e.message, true) }
  })

  // Refresco en vivo. Se detiene con la pestaña oculta para no consultar PRIME
  // sin motivo, y se dispara al volver el foco.
  setInterval(() => { if (!document.hidden) cargarAgenda({ silencioso: true }) },
    ajustes.refrescoSegundos * 1000)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) cargarAgenda({ silencioso: true })
  })

  prepararModal()

  setInterval(mostrarAntiguedad, 1000)
  setInterval(comprobarImpresora, 60000)
}

iniciar().catch((e) => avisar(e.message, true))
