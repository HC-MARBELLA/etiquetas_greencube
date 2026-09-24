# Impresión de etiquetas de paciente

Aplicación web de mostrador para imprimir etiquetas de paciente en una **Zebra
GK420t en red**, sin pasar por la impresora predeterminada de Windows.

## El problema que resuelve

Green Cube imprime las etiquetas por la impresora predeterminada de Windows, sin
dar a elegir. En el mostrador esa predeterminada es una impresora de papel
normal, así que las admisionistas cargaban hojas A4 de pegatinas en ella: se
atascaba y bloqueaba el resto de impresiones del centro.

Esta aplicación habla **directamente con la Zebra por TCP/9100 en ZPL**, sin
driver ni cola de impresión de por medio. La impresora predeterminada del puesto
deja de ser relevante.

## Estado

| Parte | Estado |
| --- | --- |
| Generación de ZPL y envío a la Zebra | Funcionando |
| Interfaz de mostrador (listado + botón imprimir) | Funcionando |
| Lectura de estado de la impresora | Funcionando |
| Datos reales desde PRIME | **Pendiente de acceso** — ver abajo |

Mientras no haya acceso a PRIME, la aplicación arranca con `ORIGEN_DATOS=mock` y
sirve un listado de pacientes **ficticios**. Todo lo demás es definitivo.

## Puesta en marcha

```bash
npm install
cp .env.example .env    # ajustar si hace falta
npm run dev             # http://localhost:3000
```

## Despliegue en NAS241

Queda en `http://10.0.0.241:5100`. Se usa el rango 50xx porque el 3000 del NAS
ya lo ocupa `hcmarbella_caddy`.

```bash
# En el NAS, siguiendo la convención del resto de aplicaciones
mkdir -p /share/Container/ETIQUETAS_GREENCUBE
cd /share/Container/ETIQUETAS_GREENCUBE

# Bajar compose y configuración del repositorio
git clone https://github.com/HC-MARBELLA/etiquetas_greencube.git .

# Credenciales de PRIME: NO están en el repositorio
cp .env.example .env
vi .env          # rellenar PRIME_USUARIO y PRIME_PASSWORD

docker compose -f docker-compose.qnap.yml up -d
docker compose -f docker-compose.qnap.yml ps
```

Si el paquete de GHCR es privado, el NAS necesita credenciales para bajarlo:
`docker login ghcr.io` con un token de lectura de paquetes, una sola vez.

Comprobación rápida tras arrancar:

```bash
curl -s http://10.0.0.241:5100/salud
```

### Red

El NAS está en `10.0.0.241` (interfaz `internal` del FortiGate) y la Zebra en
`10.0.1.141` (`internal2`), en subredes distintas. **El tráfico está
permitido**: lo cubre la policy 10 `LAN --> LAN2` (`internal` → `internal2`,
srcaddr `all`, service ALL, accept). Verificado contra el propio dispositivo:

```
# diagnose firewall iprope lookup 10.0.0.241 12345 10.0.1.141 9100 6 internal
  matches policy id: 10
```

PRIME (`10.0.0.16`) está en la misma subred que el NAS, así que ese tráfico ni
llega a pasar por el cortafuegos.

### Publicación e imagen

`.github/workflows/publicar.yml` comprueba tipos y sintaxis y, si pasa, publica
`ghcr.io/hc-marbella/etiquetas_greencube:latest` en cada push a `main`. El
Watchtower con ámbito `etiquetas` que define `docker-compose.qnap.yml` la
recoge y actualiza el contenedor solo.

La comprobación va **antes** de publicar a propósito: con despliegue
automático, una imagen que no compila llegaría sola al mostrador.

## La interfaz

Pantalla única pensada para un mostrador: filtros arriba, resultados paginados
debajo.

- **Filtros encadenados**: fecha → especialidad → agenda. Elegir una
  especialidad reduce el desplegable de agendas a las suyas (ENFERMERÍA deja 3
  de 46) y el listado a sus citas (107 de 569).
- **Búsqueda** por nombre o nº de historia, en cliente, sin ir al servidor.
- **Paginación** de 25/50/100 filas. Un día completo son ~570 citas y un
  listado sin paginar es inmanejable en un mostrador.
- **Estado de impresión** por fila, con opción de ocultar las ya hechas.
- **Vistas guardadas** que aplican especialidad, agenda, etiquetas por defecto,
  impresora y el interruptor de ocultar impresas.

Sin dependencias de frontend ni paso de compilación: HTML servido, CSS con
tokens de diseño y JavaScript plano. Tipografía del sistema a propósito — la
aplicación tiene que abrir igual de rápido y verse igual aunque el hospital se
quede sin salida a internet.

## Datos propios

La aplicación tiene su propia base SQLite (`datos/etiquetas.db`), separada de
PRIME. Guarda dos cosas:

- **Registro de impresiones**: qué episodio, cuántas etiquetas, en qué impresora
  y desde qué puesto. De ahí sale la marca de "ya impreso" del listado, y sirve
  como rastro de auditoría.
- **Vistas guardadas**: combinaciones con nombre de agenda, etiquetas por
  defecto, impresora y el interruptor de "ocultar ya impresas". Un clic y el
  mostrador queda configurado. Guardar con un nombre existente lo actualiza.

**En PRIME no se escribe nunca.** El acceso es de solo lectura, y el histórico
clínico no es sitio para un registro de impresiones.

Se usa el SQLite que trae Node (`node:sqlite`), sin dependencias nativas, para
que la imagen de Docker siga siendo un `node:alpine` sin herramientas de
compilación. Va montado en un volumen para que sobreviva a los despliegues.

**Requiere Node 24 o superior.** En Node 22 el módulo `node:sqlite` todavía
exige arrancar con `--experimental-sqlite`, así que la imagen y el flujo de
integración fijan Node 24.

### La marca de "ya impreso"

Se agrupa **por episodio y fecha**, no por cita: lo que se quiere evitar es
imprimir dos veces las etiquetas del mismo paciente, aunque la cita cambie de
identificador al reprogramarla.

**Nunca bloquea una reimpresión.** Una etiqueta se puede estropear, caer al
suelo o hacer falta de más, así que el botón pasa a decir "Reimprimir" y sigue
funcionando. El contador acumula: dos envíos de 1 y 2 copias muestran
"3 etiquetas · 2 envíos".

## Configuración

Las impresoras se declaran en `config/impresoras.json`. Para añadir un mostrador
basta con añadir una entrada; el resto de la aplicación ya trabaja con varias.

```json
[
  {
    "id": "extracciones",
    "nombre": "Mostrador de Extracciones",
    "host": "10.0.1.141",
    "puerto": 9100,
    "modelo": "Zebra GK420t",
    "predeterminada": true
  }
]
```

El resto de parámetros (tamaño de etiqueta, contraste, velocidad, copias por
defecto) están en `.env`. Ver `.env.example`.

## La etiqueta

Diseñada para **100 × 35 mm a 203 dpi** = 800 × 280 puntos:

- **Logo** arriba a la izquierda (siglas HC, 12 × 7,8 mm).
- **Bloque de texto** ocupando el resto, en cuerpo decreciente según importancia.
- **Code 128 abajo a la derecha**, grande: 29,6 × 10 mm, módulo de 3 puntos.

### Dos cosas que hay que respetar en el código de barras

**El modo de `^BC` no es opcional.** Sin el sexto parámetro, ZPL usa el
subconjunto B y gasta un carácter por dígito. `00000001` pasa de 79 a 123
módulos: a 3 puntos son 369 en vez de 237, y el código se sale de la etiqueta.
Cortado pierde el dígito de control y **deja de leerse por completo**. Va en
modo `A` (automático), que elige el subconjunto C para datos numéricos.

**La zona muda son 10 módulos a cada lado.** Sin ella el lector no localiza el
arranque y falla de forma intermitente aunque el símbolo esté entero. El diseño
la reserva a ambos lados y prevalece sobre el margen general.

El ancho de módulo se reduce solo (de 3 a 2) si el dato es tan largo que no
cabe, y `componerEtiqueta` devuelve la caja de cada elemento para poder
comprobarlo antes de imprimir:

```bash
npm run etiqueta:previa        # lista cada caja y avisa si algo se sale
```

El código va en esa esquina porque es la que el texto deja libre, y se aprovecha
para hacerlo lo más grande posible: estas etiquetas se escanean pegadas a tubos
de muestra, a menudo curvos y en mala posición, y ahí el tamaño del módulo es lo
que marca la diferencia entre que lea a la primera o no lea.

Las líneas que invaden la franja del código se estrechan solas; las de arriba
disponen del ancho completo, que es donde caen los nombres compuestos largos.

La composición es **dinámica**: cada campo sin valor desaparece y el resto se
recoloca. Por eso el mismo modelo sirve para extracciones (sin cama) y para
hospitalización (con cama), sin plantillas separadas. Si un nombre es demasiado
largo, el cuerpo de letra se reduce solo hasta que cabe.

Para ver el ZPL sin imprimir nada:

```bash
npm run etiqueta:previa              # etiqueta de prueba
npm run etiqueta:previa -- 3 c-003   # 3 copias de una cita concreta del mock
```

Para imprimir una etiqueta de prueba con datos inventados:

```bash
npm run etiqueta:prueba
```

## El logo

La Zebra no entiende PNG: trabaja con mapas de bits de 1 bit por píxel. Como el
logo es siempre el mismo, se guarda **una sola vez** en la memoria permanente de
la impresora y las etiquetas lo referencian con `^XG`, en lugar de mandar varios
kilobytes en cada impresión.

```bash
npm run logo -- logo.png                  # ancho por defecto 160 pt (20 mm)
npm run logo -- logo.png 200              # ancho máximo en puntos
npm run logo -- logo.png 160 100          # ajusta también el umbral (0-255)
npm run logo -- logo.png --bloques        # lista las partes del logo
npm run logo -- logo.png 96 --bloque=1    # usa solo esa parte (p.ej. las siglas)
npm run logo -- logo.png --comparar       # varios tamaños en una sola etiqueta
npm run logo -- logo.png 160 --previa     # solo calcula medidas, no imprime
```

### Quedarse solo con las siglas

En una etiqueta de 35 mm el wordmark es lo que impide reducir el logo: ocupa
altura y es lo primero que se rompe a 203 dpi. `--bloques` detecta las partes
del PNG separadas por franjas en blanco, y `--bloque=N` se queda con una:

```
logo.png: 2 bloque(s) de contenido
  --bloque=1  528x341 px en (61,34)   proporción 1.55   <- las siglas
  --bloque=2  526x76 px en (61,396)   proporción 6.92   <- el wordmark
```

Con el logo completo a 160 pt se ocupa el 52% del alto útil. Solo las siglas a
96 pt ocupan el 26%, y dejan sitio para toda la información del paciente.

El reescalado promedia el área de cada punto en lugar de tomar el píxel
central, para que los trazos finos ensombrezcan su punto en vez de desaparecer.
Si aun así se pierden, sube el umbral (`npm run logo -- logo.png 96 180`).

Rutas con espacios: el script las reconstruye solo, así que
`npm run logo -- C:\Projects\Impresora etiquetas\logo.png` funciona sin comillas.

El comando convierte el PNG, lo sube como `E:LOGO.GRF`, imprime una etiqueta de
prueba con un marco de referencia y te dice qué poner en `.env`:

```
ETIQUETA_LOGO=LOGO
ETIQUETA_LOGO_ANCHO_PT=160
ETIQUETA_LOGO_ALTO_PT=72
```

Conviene partir de un PNG **en blanco y negro puro y con buen contraste**. Si el
original tiene grises o degradados, ajusta el umbral hasta que la prueba salga
limpia: a 203 dpi no hay medios tonos, cada punto es negro o blanco.

## Mantenimiento de la impresora

```bash
npm run impresora estado             # modelo, firmware, papel, cabezal
npm run impresora patron             # etiqueta de calibración con marco y regla
npm run impresora calibrar-sensor    # ~JC: mide el papel cargado (gasta 2-3 etiquetas)
npm run impresora termica-directa    # fija térmica directa de forma permanente
npm run impresora transferencia      # vuelve a transferencia térmica (con ribbon)
```

### Ajustar el encuadre

Imprime `npm run impresora patron`. La etiqueta lleva un marco pegado al borde
del área imprimible, marcas en las cuatro esquinas y una regla en milímetros.

- Marco completo y centrado → encuadre correcto.
- Falta un lado o una esquina → el contenido se sale por ahí. La regla dice
  cuántos milímetros; se corrige subiendo `ETIQUETA_MARGEN_MM`, o desplazando
  el origen con `^LH` si el desvío es de la impresora y no del diseño.
- Marco completo pero sobra papel → el papel es mayor que lo declarado en
  `ETIQUETA_ANCHO_MM` / `ETIQUETA_ALTO_MM`.

### Notas sobre la GK420t

- La impresora venía configurada en **transferencia térmica** (con ribbon). Como
  vamos a usar papel **térmico directo**, cada trabajo incluye `^MTD`, así no
  depende de la configuración guardada en la impresora.
- `^CI28` activa UTF-8, necesario para los acentos (`ENFERMERÍA`, `Málaga`).
- Conviene **recalibrar el sensor** con el papel definitivo: la impresora tenía
  una longitud de etiqueta de 289 puntos (36,1 mm) en vez de 280. Se hace desde
  el panel web de la impresora o enviándole `~JC`.
- Etiqueta de configuración desde la propia impresora: mantener pulsado **FEED**
  hasta que el LED parpadee una vez.

## PRIME

PRIME es el SQL Server de Green Cube (`10.0.0.16:62314`). El proveedor está
implementado en `src/datos/prime.ts`. **Solo falta un login de SQL Server de
solo lectura**: rellena `PRIME_USUARIO` / `PRIME_PASSWORD` en `.env` y pon
`ORIGEN_DATOS=prime`.

Permisos necesarios (SELECT, nada más):

- `PatientManagement..Appointments`, `..Schedules`, `..Customer`
- `Configuration..agreement`, `..insurance`, `..Provinces`

### Mapeo verificado

Contrastado campo a campo contra una etiqueta impresa. Los ejemplos son los del
paciente ficticio de `datosDePrueba()`: **este repositorio no contiene datos de
pacientes reales**.

| Línea de la etiqueta | Origen en PRIME |
|---|---|
| `00000001 - PR001` | `Customer.HISTORYNUMBER` + `' - '` + `Appointments.PROCESSID` |
| Código de barras | `Customer.HISTORYNUMBER` (solo eso) |
| `PRUEBA DE IMPRESIÓN` | `FIRSTSURNAME` + `SECONDSURNAME` + `NAMECUSTOMER` |
| `X0000000T` | `Customer.TIN` |
| `01/01/1970` | `Customer.DATEBIRTH` |
| `ASEGURADORA - CONVENIO` | `insurance.ENTITY` + `' - '` + `agreement.ENTITY` |
| Nº Póliza | `Customer.NUMBERPOLICY` |
| `CALLE DE PRUEBA 1` | `Customer.ADDRESS` + `' '` + `Customer.NUMBERADRESS` |
| `Málaga` | `Provinces.NAME` — la **provincia**, no la localidad |

`TOWNVILLA` y `CITYNAME` están vacíos en la práctica; lo que la etiqueta actual
imprime como población es en realidad la provincia.

### Cosas que hay que saber al consultar

- **Excluir siempre `CUSTOMERID <> 'PACIENTE_BLOQUEO'`**: es un paciente falso
  que Green Cube usa para bloquear huecos de agenda y genera cientos de "citas"
  al día.
- **Filtrar por `CONSULTATIONCODEID`, nunca por nombre de agenda.** Los nombres
  se repiten: hay tres agendas "ENFERMERÍA" (`ENF00A` extracciones, `ENF00L`
  extracciones 2, `ENF00B` oncología) y más de veinte "MEDICINA GENERAL". Lo que
  las distingue es el código, y para mostrarlas se concatena
  `CONSULTATIONNAME + ' - ' + CONSULTATIONDESCRIPTION`.
- `HEALTHCENTREID = '9359'` es Marbella (9360 Ceuta, 888 externos).
- Los campos son `CHAR` con relleno: hay que hacer `RTRIM` en todo.
- **Muchos pacientes no tienen documento ni póliza.** En la agenda de
  extracciones de un día, 26 de 51 no tienen `TIN`. Por eso la etiqueta se
  compone dinámicamente en vez de reservar hueco para cada campo.
- La aplicación **nunca escribe en PRIME**.

## Protección de datos

Las etiquetas contienen datos de salud (nombre, documento, nº de póliza).

- Los datos **no salen de la red interna**: el servidor habla con PRIME y con la
  impresora, y nada más.
- En los logs se registra el **episodio**, nunca el nombre del paciente: basta
  para auditoría sin dejar datos identificativos.
- `src/datos/mock.ts` va a Git: **solo datos inventados**, nunca pacientes
  reales.
- Si usas un visor de ZPL online (labelary.com y similares) recuerda que es un
  servicio externo: solo con los datos de `datosDePrueba()`.
