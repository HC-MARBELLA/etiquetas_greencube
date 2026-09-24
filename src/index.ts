import { resolve } from 'node:path'
import Fastify from 'fastify'
import estaticos from '@fastify/static'
import { config, raizProyecto } from './config.js'
import { cerrarPrime } from './datos/prime.js'
import { cerrarRegistro } from './datos/registro.js'
import { registrarRutas } from './rutas.js'

const app = Fastify({
  logger: {
    level: process.env['LOG_NIVEL'] ?? 'info',
    transport:
      process.env['NODE_ENV'] === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
})

await app.register(estaticos, {
  root: resolve(raizProyecto, 'public'),
  prefix: '/',
})

await registrarRutas(app)

app.setErrorHandler<Error & { statusCode?: number }>((error, _peticion, respuesta) => {
  app.log.error(error)
  respuesta.status(error.statusCode ?? 500).send({ error: error.message })
})

// Cierre ordenado: sin esto quedan sesiones colgadas en PRIME al reiniciar.
for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(senal, () => {
    void (async () => {
      app.log.info(`Recibido ${senal}, cerrando`)
      await app.close()
      await cerrarPrime()
      cerrarRegistro()
      process.exit(0)
    })()
  })
}

try {
  await app.listen({ port: config.puerto, host: config.host })
  app.log.info(
    `Origen de datos: ${config.origenDatos} · Impresoras: ${config.impresoras
      .map((i) => `${i.id} (${i.host}:${i.puerto})`)
      .join(', ')}`,
  )
} catch (e) {
  app.log.error(e)
  process.exit(1)
}
