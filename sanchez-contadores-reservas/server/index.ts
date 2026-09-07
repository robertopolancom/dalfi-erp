import path from 'node:path'
import { crearApp } from './app.ts'
import { crearPool, obtenerPool } from './db.ts'

crearPool()

// Se resuelve desde el directorio de trabajo y no desde el del módulo: el
// compilado vive en dist-server/server/ y el fuente en server/, así que una
// ruta relativa al módulo apuntaría a sitios distintos según cómo se arranque.
// Tanto `npm start` como `npm run dev:server` corren desde la raíz del proyecto.
const app = crearApp({
  directorioEstatico: process.env['DIR_ESTATICO']
    ?? path.resolve(process.cwd(), 'dist'),
})

const puerto = Number(process.env['PORT'] ?? 3000)
const servidor = app.listen(puerto, '0.0.0.0', () => {
  console.log(`Reservas Sánchez Contadores escuchando en el puerto ${puerto}.`)
})

async function apagar(senal: string) {
  console.log(`${senal}: cerrando el servidor.`)
  servidor.close(async () => {
    await obtenerPool().end()
    process.exit(0)
  })
}

process.on('SIGTERM', () => void apagar('SIGTERM'))
process.on('SIGINT', () => void apagar('SIGINT'))
