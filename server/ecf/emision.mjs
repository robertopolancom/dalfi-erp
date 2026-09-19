// Emisión de e-CF: el flujo completo entre el ERP, la tabla app.ecf_documentos y el PSFE.
//
//   emitir(origen, id)  -> arma el documento neutral, reserva el e-NCF, lo manda al PSFE y guarda
//                          el resultado. Es idempotente: si ya hay uno aceptado, lo devuelve.
//   procesarCola()      -> lo que llama el cron cada 5 minutos: reintenta los que fallaron (el PSFE
//                          caído no pierde facturas) y consulta los que quedaron "en proceso".
//   notaDeCredito(...)  -> la única forma de anular un e-CF aceptado (E34 que referencia al original).
//
// Nada de esto corre sin RNC del emisor: en modo prueba se responde con un error claro y la vista
// fiscal de la factura sigue mostrando el ejemplo simulado. Así, mientras Dalfi termina la
// constitución, en producción no se escribe ni un registro fiscal.

import { documentoDesdeFactura, documentoDesdeVentaDirecta, notaDeCreditoTotal, emisorDesdeEntorno } from "./documento.mjs";
import { crearServicioECF, ADAPTADORES } from "./servicio.mjs";

// Espera antes de reintentar, según cuántos intentos van: 2, 5, 15, 30 min, 1 h, y luego cada 3 h.
const ESPERAS_MIN = [2, 5, 15, 30, 60];
function proximoIntento(intentos, ahora = Date.now()) {
  const min = ESPERAS_MIN[intentos] ?? 180;
  return new Date(ahora + min * 60_000).toISOString();
}

const ESTADOS_FINALES = new Set(["aceptado", "aceptado_condicional", "rechazado"]);

export function crearEmisionECF({ env = {}, store, leerDocumentoERP, adaptadores = ADAPTADORES, ahora = () => Date.now() }) {
  const emisor = () => emisorDesdeEntorno(env);
  const servicioPara = (proveedor) => crearServicioECF({ env: { ...env, ECF_PSFE: proveedor }, adaptadores });

  function exigirEmisorReal() {
    if (emisor().modo !== "real") {
      throw Object.assign(new Error("Todavía no hay RNC del emisor (ECF_EMISOR_RNC). Usa la vista de prueba de la factura."), { code: "ECF_SIN_EMISOR", status: 409 });
    }
  }

  // Manda un registro ya creado al PSFE y guarda lo que responda. Un fallo de red o del proveedor
  // deja el registro en "error" con su próximo intento: la cola lo retoma.
  async function enviar(registro) {
    const servicio = servicioPara(registro.proveedor);
    try {
      const r = await servicio.emitir(registro.documento);
      return await store.ecfActualizar(registro.id, {
        estado: r.estado || "en_proceso",
        trackId: r.trackId,
        codigoSeguridad: r.codigoSeguridad,
        fechaFirma: r.fechaFirma,
        respuesta: r,
        error: r.estado === "rechazado" ? String(r.mensajes?.join?.("; ") || "Rechazado por la DGII") : null,
        proximoIntento: r.estado === "en_proceso" ? proximoIntento(0, ahora()) : null,
        sumarIntento: true,
      });
    } catch (error) {
      return store.ecfActualizar(registro.id, {
        estado: "error",
        error: String(error?.message || error).slice(0, 500),
        proximoIntento: proximoIntento(Number(registro.intentos) || 0, ahora()),
        sumarIntento: true,
      });
    }
  }

  async function armarDocumento(origen, id) {
    const documentoERP = await leerDocumentoERP();
    const doc = origen === "venta"
      ? documentoDesdeVentaDirecta(documentoERP, id, { emisor: emisor() })
      : documentoDesdeFactura(documentoERP, id, { emisor: emisor() });
    if (!doc) throw Object.assign(new Error("Ese documento no existe en el ERP."), { code: "ECF_NO_EXISTE", status: 404 });
    if (!doc.lineas.length || doc.totales.montoTotal <= 0) {
      throw Object.assign(new Error("El documento no tiene líneas con monto: no se puede emitir."), { code: "ECF_VACIO", status: 400 });
    }
    return doc;
  }

  return {
    async emitir(origen, id) {
      exigirEmisorReal();
      if (!["factura", "venta"].includes(origen)) throw Object.assign(new Error("Origen inválido."), { status: 400 });
      const existentes = await store.ecfPorOrigen(origen, id);
      const principal = existentes.find((r) => r.origen === origen);
      if (principal && ESTADOS_FINALES.has(principal.estado) && principal.estado !== "rechazado") return principal;
      if (principal?.estado === "rechazado") {
        // Rechazado por la DGII: casi siempre es un dato mal (RNC del comprador, montos). Se vuelve
        // a armar desde el ERP, ya corregido, conservando el mismo e-NCF. (Si la DGII no permite
        // reusar un e-NCF rechazado, esto es lo que hay que cambiar: confirmar con su normativa.)
        const doc = await armarDocumento(origen, id);
        const actualizado = await store.ecfActualizar(principal.id, { documento: { ...doc, encf: principal.encf }, estado: "pendiente" });
        return enviar(actualizado);
      }
      if (principal) return enviar(principal); // pendiente o en error: se reintenta el mismo
      const doc = await armarDocumento(origen, id);
      const registro = await store.ecfCrear({ origen, origenId: id, tipo: doc.tipo, proveedor: String(env.ECF_PSFE || "simulado"), documento: doc });
      return enviar(registro);
    },

    async notaDeCredito(origen, id, { motivo } = {}) {
      exigirEmisorReal();
      const existentes = await store.ecfPorOrigen(origen, id);
      const original = existentes.find((r) => r.origen === origen && (r.estado === "aceptado" || r.estado === "aceptado_condicional"));
      if (!original) throw Object.assign(new Error("Ese documento no tiene un e-CF aceptado: se anula normal, sin nota de crédito."), { code: "ECF_SIN_ORIGINAL", status: 409 });
      const yaAnulado = existentes.find((r) => r.origen === "nota_credito" && r.referencia_encf === original.encf && r.estado !== "rechazado");
      if (yaAnulado) return yaAnulado;
      const nota = notaDeCreditoTotal(original.documento, { motivo, fecha: new Date(ahora()).toISOString() });
      const registro = await store.ecfCrear({
        origen: "nota_credito", origenId: id, tipo: "34", proveedor: String(env.ECF_PSFE || "simulado"),
        documento: nota, referenciaEncf: original.encf,
      });
      return enviar(registro);
    },

    async procesarCola({ limite = 20 } = {}) {
      if (emisor().modo !== "real") return { procesados: 0, omitido: "sin_emisor" };
      const pendientes = await store.ecfPendientes(limite);
      let procesados = 0;
      for (const registro of pendientes) {
        if (registro.estado === "en_proceso" && registro.track_id) {
          try {
            const r = await servicioPara(registro.proveedor).consultarEstado({ trackId: registro.track_id, encf: registro.encf });
            await store.ecfActualizar(registro.id, {
              estado: r.estado,
              respuesta: r,
              error: r.estado === "rechazado" ? String(r.mensajes?.join?.("; ") || "Rechazado por la DGII") : null,
              proximoIntento: r.estado === "en_proceso" ? proximoIntento(Number(registro.intentos) || 0, ahora()) : null,
              sumarIntento: true,
            });
          } catch (error) {
            await store.ecfActualizar(registro.id, { error: String(error?.message || error).slice(0, 500), proximoIntento: proximoIntento(Number(registro.intentos) || 0, ahora()), sumarIntento: true });
          }
        } else {
          await enviar(registro);
        }
        procesados += 1;
      }
      return { procesados };
    },
  };
}
