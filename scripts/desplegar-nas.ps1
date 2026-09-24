<#
.SYNOPSIS
  Despliega la aplicación de etiquetas en NAS241 por SSH.

.DESCRIPTION
  El NAS no necesita el código: la imagen se baja de GHCR. Solo hay que
  llevarle tres ficheros y levantar el compose.

    docker-compose.qnap.yml   definición de los contenedores
    config/impresoras.json    IPs de las impresoras
    .env                      credenciales de PRIME (nunca va al repositorio)

  Se copian por scp en lugar de clonar el repositorio porque QNAP no trae git.

  El script es idempotente: se puede volver a ejecutar para actualizar la
  configuración o forzar un redespliegue.

.EXAMPLE
  .\scripts\desplegar-nas.ps1
  .\scripts\desplegar-nas.ps1 -NasUsuario admin -Destino /share/Container/ETIQUETAS
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

function Paso($texto) { Write-Host "`n=== $texto ===" -ForegroundColor Cyan }
function Bien($texto) { Write-Host "  OK  $texto" -ForegroundColor Green }
function Mal($texto)  { Write-Host "  !!  $texto" -ForegroundColor Red }

# --- Comprobaciones antes de tocar el NAS -----------------------------------

Paso 'Comprobando lo que hay que enviar'

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  Mal 'No hay cliente ssh. Instala OpenSSH: Configuración > Aplicaciones > Características opcionales.'
  exit 1
}

$ficheros = @(
  @{ local = Join-Path $raiz $Compose;                    remoto = $Compose }
  @{ local = Join-Path $raiz '.env';                      remoto = '.env' }
  @{ local = Join-Path $raiz 'config\impresoras.json';    remoto = 'config/impresoras.json' }
)

foreach ($f in $ficheros) {
  if (-not (Test-Path $f.local)) { Mal "Falta $($f.local)"; exit 1 }
  Bien $f.remoto
}

# El error más probable: desplegar con el .env sin rellenar y que la aplicación
# arranque sin poder consultar PRIME.
$env_contenido = Get-Content (Join-Path $raiz '.env') -Raw
if ($env_contenido -notmatch '(?m)^PRIME_USUARIO=\S' -or $env_contenido -notmatch '(?m)^PRIME_PASSWORD=\S') {
  Mal 'El .env no tiene PRIME_USUARIO o PRIME_PASSWORD. Rellénalos antes de desplegar.'
  exit 1
}
Bien 'Credenciales de PRIME presentes en .env'

# --- Envío -------------------------------------------------------------------

$ssh = @('-p', $NasPuerto, '-o', 'StrictHostKeyChecking=accept-new')
$scp = @('-P', $NasPuerto, '-o', 'StrictHostKeyChecking=accept-new')
$maquina = "$NasUsuario@$NasHost"

Paso "Creando $Destino en $NasHost"
& ssh @ssh $maquina "mkdir -p '$Destino/config'"
if ($LASTEXITCODE -ne 0) { Mal 'No se pudo conectar o crear el directorio.'; exit 1 }
Bien 'Directorio listo'

Paso 'Copiando ficheros'
foreach ($f in $ficheros) {
  & scp @scp $f.local "${maquina}:$Destino/$($f.remoto)"
  if ($LASTEXITCODE -ne 0) { Mal "Falló la copia de $($f.remoto)"; exit 1 }
  Bien $f.remoto
}

# El .env lleva credenciales: que no lo lea todo el mundo en el NAS.
& ssh @ssh $maquina "chmod 600 '$Destino/.env'"

# --- Despliegue ---------------------------------------------------------------

Paso 'Bajando la imagen de GHCR'
& ssh @ssh $maquina "cd '$Destino' && docker compose -f $Compose pull"
if ($LASTEXITCODE -ne 0) {
  Mal 'No se pudo bajar la imagen.'
  Write-Host '  Si el paquete de GHCR es privado, haz una vez en el NAS:' -ForegroundColor Yellow
  Write-Host '    docker login ghcr.io -u <usuario>' -ForegroundColor Yellow
  exit 1
}

Paso 'Levantando los contenedores'
& ssh @ssh $maquina "cd '$Destino' && docker compose -f $Compose up -d"
if ($LASTEXITCODE -ne 0) { Mal 'Falló el arranque.'; exit 1 }

# --- Verificación --------------------------------------------------------------

Paso 'Esperando a que el healthcheck responda'
$sano = $false
foreach ($intento in 1..12) {
  Start-Sleep -Seconds 5
  $estado = & ssh @ssh $maquina "docker inspect hcmarbella_etiquetas --format '{{.State.Health.Status}}'" 2>$null
  Write-Host "  intento $intento : $estado"
  if ($estado -match 'healthy') { $sano = $true; break }
  if ($estado -match 'unhealthy') { break }
}

Paso 'Estado final'
& ssh @ssh $maquina "cd '$Destino' && docker compose -f $Compose ps"

if ($sano) {
  Bien "Desplegado en http://${NasHost}:$PuertoWeb"
  & ssh @ssh $maquina "wget -qO- http://127.0.0.1:$PuertoWeb/salud"
} else {
  Mal 'El contenedor no llegó a estado healthy. Últimas líneas del log:'
  & ssh @ssh $maquina "docker logs --tail 40 hcmarbella_etiquetas"
  exit 1
}
