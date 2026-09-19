// servicio-ecf: la pieza intermedia entre el ERP y los proveedores de facturación electrónica.
//
// Decisión de diseño (Roberto, 2026-09-18): no depender de un solo PSFE. El ERP le habla SOLO a
// esta pieza, con nuestro documento neutral (documento.mjs). Cada proveedor tiene su adaptador
// pequeño que traduce ese documento a su API. Cambiar a un cliente de proveedor es cambiar
// ECF_PSFE en su configuración; el punto de venta, la caja y el inventario no se tocan. (El
// cliente sí hace un trámite corto ante la DGII para indicar el proveedor nuevo.)
//
// Contrato de un adaptador:
//   emitir(documento, { env }) -> { encf, codigoSeguridad, fechaFirma, trackId, estado }
//   consultarEstado({ trackId, encf }, { env }) -> { estado, mensajes }
// estado ∈ "aceptado" | "aceptado_condicional" | "rechazado" | "en_proceso".
//
// La secuencia de e-NCF es del CONTRIBUYENTE, no del proveedor: al cambiar de PSFE el nuevo
// sigue desde el último número emitido. Cada e-CF guardará con qué adaptador salió, para que los
// que queden en proceso se terminen de consultar con el anterior.
//
// Adaptadores disponibles hoy: "simulado". Los de Alanube y The Factory HKA se escriben con su
// documentación de API y una cuenta de pruebas (sandbox) de cada uno: sin eso quedarían escritos
// a ciegas, y un adaptador sin probar contra el proveedor real es peor que no tenerlo.

import { randomBytes } from "node:crypto";

const ALFANUMERICO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

// Para desarrollo y pruebas: responde como un PSFE, sin red y sin DGII. Todo lo que sale de aquí
// va marcado como simulado y la factura lo dice en grande.
export function adaptadorSimulado() {
  const secuencias = new Map();
  return {
    nombre: "simulado",
    async emitir(documento) {
      const siguiente = (secuencias.get(documento.tipo) || 0) + 1;
      secuencias.set(documento.tipo, siguiente);
      const bytes = randomBytes(6);
      const codigoSeguridad = [...bytes].map((b) => ALFANUMERICO[b % ALFANUMERICO.length]).join("");
      return {
        // El e-NCF lo asigna NUESTRA secuencia (es del contribuyente); el simulado solo inventa
        // uno si no le llega ninguno (vista de prueba).
        encf: documento.encf || `E${documento.tipo}${String(siguiente).padStart(10, "0")}`,
        codigoSeguridad,
        fechaFirma: new Date().toISOString(),
        trackId: `SIM-${randomBytes(8).toString("hex")}`,
        estado: "aceptado",
        simulado: true,
      };
    },
    async consultarEstado({ trackId }) {
      return { estado: String(trackId || "").startsWith("SIM-") ? "aceptado" : "en_proceso", mensajes: [], simulado: true };
    },
  };
}

export const ADAPTADORES = {
  simulado: adaptadorSimulado,
};

export function crearServicioECF({ env = {}, adaptadores = ADAPTADORES } = {}) {
  const nombre = String(env.ECF_PSFE || "simulado");
  const fabrica = adaptadores[nombre];
  if (!fabrica) throw new Error(`No hay adaptador de PSFE "${nombre}". Disponibles: ${Object.keys(adaptadores).join(", ")}.`);
  const adaptador = fabrica();
  return {
    proveedor: nombre,
    async emitir(documento) {
      // Nunca se manda a un PSFE real un documento sin emisor con RNC: saldría rechazado, o peor,
      // a nombre equivocado. El simulado sí acepta modo prueba: para eso existe.
      if (nombre !== "simulado" && documento?.modo !== "real") {
        throw new Error("El emisor no tiene RNC configurado (ECF_EMISOR_RNC): no se envía nada al PSFE.");
      }
      const resultado = await adaptador.emitir(documento, { env });
      return { ...resultado, proveedor: nombre };
    },
    async consultarEstado(referencia) {
      return { ...(await adaptador.consultarEstado(referencia, { env })), proveedor: nombre };
    },
  };
}
