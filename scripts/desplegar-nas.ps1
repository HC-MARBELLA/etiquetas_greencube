<#
.SYNOPSIS
  Despliega la aplicación de etiquetas en NAS241 por SSH.

.DESCRIPTION
  El NAS no necesita el código: la imagen se baja de GHCR. Solo hay que
  llevarle tres ficheros y levantar el compose.

    docker-compose.qnap.yml   definición de los contenedores
    config/impresoras.json    IPs de las impresoras
    .env                      credenciales de PRIME (nunca va al repositorio)

  Cuatro particularidades del QNAP condicionan cómo se hace:

  1. No tiene habilitado el subsistema SFTP, así que `scp` falla con
     "subsystem request failed". Los ficheros se escriben con here-docs
     dentro del propio guion remoto.
  2. Su `base64 -d` rechaza la entrada según qué shell lo invoque, de ahí que
     todo viaje literal y no codificado.
  3. `docker` no está en el PATH de una sesión SSH no interactiva: vive bajo
     el paquete Container Station y el guion lo localiza al arrancar.
  4. No trae git, de modo que clonar el repositorio allí no es viable.

  Además se normalizan los finales de línea a LF. El repositorio guarda LF
  pero la copia de trabajo en Windows es CRLF, y un `.env` con CRLF haría que
  Docker Compose metiera un retorno de carro al final de la contraseña de
  PRIME: la autenticación fallaría con un error desconcertante.

  Todo va en una sola conexión SSH, así que la contraseña se pide una vez.
  El script es idempotente.

.EXAMPLE
  .\scripts\desplegar-nas.ps1
  .\scripts\desplegar-nas.ps1 -NasUsuario admin
#>
[CmdletBinding()]
param(
  [string]$NasHost    = '10.0.0.241',
  [int]   $NasPuerto  = 223,
  [string]$NasUsuario = 'admin',
  [string]$Destino    = '/share/Container/ETIQUETAS_GREENCUBE',
  [string]$Compose    = 'docker-compose.qnap.yml',
  [int]   $PuertoWeb  = 5100
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot

function Paso($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Bien($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Mal($t)  { Write-Host "  !!  $t" -ForegroundColor Red }

# --- Comprobaciones antes de tocar el NAS -----------------------------------

Paso 'Comprobando lo que hay que enviar'

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  Mal 'No hay cliente ssh. Instálalo desde Configuración > Aplicaciones > Características opcionales.'
  exit 1
}

$ficheros = @(
  @{ local = Join-Path $raiz $Compose;                 remoto = $Compose }
  @{ local = Join-Path $raiz '.env';                   remoto = '.env' }
  @{ local = Join-Path $raiz 'config\impresoras.json'; remoto = 'config/impresoras.json' }
)

foreach ($f in $ficheros) {
  if (-not (Test-Path $f.local)) { Mal "Falta $($f.local)"; exit 1 }
  Bien $f.remoto
}

# El error más probable: desplegar con el .env sin rellenar y que la aplicación
# arranque sana pero sin poder consultar la agenda.
$envLocal = [System.IO.File]::ReadAllText((Join-Path $raiz '.env'))
if ($envLocal -notmatch '(?m)^PRIME_USUARIO=\S' -or $envLocal -notmatch '(?m)^PRIME_PASSWORD=\S') {
  Mal 'El .env no tiene PRIME_USUARIO o PRIME_PASSWORD. Rellénalos antes de desplegar.'
  exit 1
}
Bien 'Credenciales de PRIME presentes en .env'

# --- Construcción del guion remoto -------------------------------------------

# Marca de fin de fichero. Va entre comillas simples en el here-doc para que el
# shell NO expanda nada del contenido: la contraseña de PRIME contiene un '$'
# y sin proteger el delimitador llegaría truncada al NAS.
$FIN = '__FIN_DE_FICHERO__'

function BloqueFichero($rutaLocal, $rutaRemota) {
  # Finales de línea a LF: ver la nota de la cabecera.
  $contenido = ([System.IO.File]::ReadAllText($rutaLocal)) -replace "`r`n", "`n"

  if ($contenido -match "(?m)^$FIN$") {
    throw "El fichero $rutaRemota contiene la marca de fin. Cambia `$FIN en el script."
  }

  return @(
    "echo '  escribiendo $rutaRemota'"
    "cat > '$rutaRemota' <<'$FIN'"
    $contenido.TrimEnd("`n")
    $FIN
  )
}

$lineas = @(
  'set -e'
  ''
  '# En QNAP, docker no está en el PATH de una sesión SSH no interactiva:'
  '# vive bajo el paquete Container Station, cuya ruta depende del volumen.'
  'if ! command -v docker >/dev/null 2>&1; then'
  '  for d in /usr/local/bin /share/*/.qpkg/container-station/bin \'
  '           /share/*/.qpkg/container-station/usr/bin; do'
  '    if [ -x "$d/docker" ]; then PATH="$d:$PATH"; export PATH; break; fi'
  '  done'
  'fi'
  'if ! command -v docker >/dev/null 2>&1; then'
  '  echo "No se encuentra el binario docker en el NAS." >&2'
  '  exit 127'
  'fi'
  'echo "docker: $(command -v docker)"'
  ''
  "mkdir -p '$Destino/config'"
  "cd '$Destino'"
  'echo "--- Escribiendo configuracion ---"'
)

foreach ($f in $ficheros) {
  $lineas += BloqueFichero $f.local $f.remoto
}

$lineas += @(
  "chmod 600 .env"
  'echo "--- Bajando imagen de GHCR ---"'
  "docker compose -f $Compose pull"
  'echo "--- Levantando contenedores ---"'
  "docker compose -f $Compose up -d"
  'echo "--- Esperando healthcheck ---"'
  'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do'
  '  s=$(docker inspect hcmarbella_etiquetas --format "{{.State.Health.Status}}" 2>/dev/null || echo sin-estado)'
  '  echo "  intento $i: $s"'
  '  if [ "$s" = "healthy" ]; then break; fi'
  '  sleep 5'
  'done'
  'echo "--- Estado ---"'
  "docker compose -f $Compose ps"
  'echo "--- Sonda de vida ---"'
  "wget -qO- http://127.0.0.1:$PuertoWeb/salud || echo 'sin respuesta en /salud'"
  'echo "--- Ultimas lineas del log ---"'
  'docker logs --tail 25 hcmarbella_etiquetas 2>&1 || true'
)

$guion = ($lineas -join "`n") + "`n"

# El guion se escribe en un temporal con finales de línea LF y se envía por la
# entrada estándar de ssh. Se usa cmd porque PowerShell 5.1 no tiene
# redirección de entrada '<', y porque canalizar la cadena desde PowerShell
# convertiría los saltos de línea a CRLF y rompería los here-docs.
$temporal = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($temporal, $guion, (New-Object System.Text.UTF8Encoding $false))

# --- Ejecución ----------------------------------------------------------------

Paso "Desplegando en $NasHost (se pedirá la contraseña una sola vez)"

try {
  $orden = "ssh -p $NasPuerto -o StrictHostKeyChecking=accept-new " +
           "$NasUsuario@$NasHost `"sh -s`" < `"$temporal`""
  & cmd /c $orden
  $codigo = $LASTEXITCODE
} finally {
  Remove-Item $temporal -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($codigo -eq 0) {
  Bien "Desplegado. Abre http://${NasHost}:$PuertoWeb"
} else {
  Mal "El despliegue terminó con código $codigo. Revisa la salida de arriba."
  exit $codigo
}
