import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import PaginaReservar from './features/publico/PaginaReservar'
import PaginaExito from './features/publico/PaginaExito'
import PaginaConsulta from './features/publico/PaginaConsulta'
import { Cargando } from './components/Cargando'

// El panel se carga bajo demanda: los centros educativos, que entran desde el
// móvil, no deberían descargar el código de administración ni la librería de
// Excel para reservar una fecha.
const PaginaLogin     = lazy(() => import('./features/admin/PaginaLogin'))
const LayoutAdmin     = lazy(() => import('./features/admin/LayoutAdmin'))
const PanelCalendario = lazy(() => import('./features/admin/PanelCalendario'))
const PanelReservas   = lazy(() => import('./features/admin/PanelReservas'))
const PanelSolicitudes = lazy(() => import('./features/admin/PanelSolicitudes'))
const PanelBloqueos   = lazy(() => import('./features/admin/PanelBloqueos'))
const PanelCentros    = lazy(() => import('./features/admin/PanelCentros'))
const PanelAjustes    = lazy(() => import('./features/admin/PanelAjustes'))

export default function App() {
  return (
    <Suspense fallback={<Cargando />}>
    <Routes>
      <Route path="/" element={<PaginaReservar />} />
      <Route path="/exito" element={<PaginaExito />} />
      <Route path="/consulta" element={<PaginaConsulta />} />

      <Route path="/admin/entrar" element={<PaginaLogin />} />
      <Route path="/admin" element={<LayoutAdmin />}>
        <Route index element={<Navigate to="/admin/calendario" replace />} />
        <Route path="calendario" element={<PanelCalendario />} />
        <Route path="reservas" element={<PanelReservas />} />
        <Route path="solicitudes" element={<PanelSolicitudes />} />
        <Route path="bloqueos" element={<PanelBloqueos />} />
        <Route path="centros" element={<PanelCentros />} />
        <Route path="ajustes" element={<PanelAjustes />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}
