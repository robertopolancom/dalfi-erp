// Tomar una conversación, contra el SQL real.
//
// Esto es lo único que impide que dos personas le escriban a la misma clienta a la vez. Hasta el
// 2026-09-16 la asignación era un efecto secundario de responder (`assigned_staff_id = coalesce(...)`
// dentro de recordStaffReply) y, peor, se escribía DESPUÉS de haber mandado el WhatsApp: dos
// agentes podían contestar y el sistema solo se enteraba al leer el hilo, con dos mensajes fuera.
//
// Toda la seguridad está en que la condición y la escritura viajen en la MISMA sentencia. Estas
// pruebas verifican la sentencia, no el resultado de un doble: un SELECT y luego un UPDATE
// pasarían cualquier prueba de comportamiento y tendrían exactamente el hueco que esto cierra.

import assert from "node:assert/strict";
import test from "node:test";
import { NeonChatStore, dentroDeLaVentana, VENTANA_WHATSAPP_MS } from "../server/store.mjs";

// Pool falso que simula de verdad la exclusión de Postgres: la fila tiene un dueño y el UPDATE
// condicional solo acierta si el WHERE se cumple en el momento de ejecutarse.
function poolConUnaFila({ asignadaA = null } = {}) {
  const estado = { asignadaA, lecturas: 0 };
  const consultas = [];
  return {
    estado,
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      // Se distingue por lo que ESCRIBE cada sentencia, no por lo que menciona: soltar también
      // nombra `assigned_staff_id = $2`, pero en el WHERE. Mirarlo suelto hacía que soltar
      // acabara tomando.
      if (sql.includes("set assigned_staff_id = $2")) {
        const [, staffId] = params;
        const libre = estado.asignadaA === null || estado.asignadaA === staffId;
        if (!libre) return { rowCount: 0, rows: [] };
        estado.asignadaA = staffId;
        return { rowCount: 1, rows: [{ assigned_staff_id: staffId }] };
      }
      if (sql.includes("set assigned_staff_id = null")) {
        const [, staffId] = params;
        if (estado.asignadaA !== staffId) return { rowCount: 0, rows: [] };
        estado.asignadaA = null;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("select c.assigned_staff_id")) {
        estado.lecturas += 1;
        return { rows: [{ assigned_staff_id: estado.asignadaA, assigned_staff_name: estado.asignadaA ? "Milady" : null }] };
      }
      throw new Error(`Consulta no simulada: ${sql}`);
    },
  };
}

test("ASG01 — dos agentes a la vez: gana uno y el otro recibe 'ocupada' con el nombre", async () => {
  const pool = poolConUnaFila();
  const store = new NeonChatStore(pool);
  const [a, b] = await Promise.all([
    store.claimConversation({ conversationId: "c1", staffId: "staff-A" }),
    store.claimConversation({ conversationId: "c1", staffId: "staff-B" }),
  ]);
  const ganadores = [a, b].filter((r) => r.ok);
  assert.equal(ganadores.length, 1, "no pueden ganar los dos");
  const perdedor = [a, b].find((r) => !r.ok);
  assert.equal(perdedor.reason, "ocupada");
  assert.equal(perdedor.assignedStaffName, "Milady", "hay que poder decirle a quién preguntarle");
});

test("ASG02 — la condición y la escritura van en la MISMA sentencia", async () => {
  const pool = poolConUnaFila();
  await new NeonChatStore(pool).claimConversation({ conversationId: "c1", staffId: "staff-A" });
  const update = pool.consultas.find((q) => q.sql.includes("update app.chat_conversations"));
  assert.match(update.sql, /where\s+id = \$1\s+and \(assigned_staff_id is null or assigned_staff_id = \$2\)/,
    "comprobar con un SELECT y actualizar después reabre la carrera que esto cierra");
  // Y no puede haber una lectura previa que "decida" si se puede: eso sería el patrón roto.
  assert.equal(pool.estado.lecturas, 0);
});

test("ASG03 — volver a tomarla uno mismo no falla (segundo dispositivo)", async () => {
  const pool = poolConUnaFila({ asignadaA: "staff-A" });
  const r = await new NeonChatStore(pool).claimConversation({ conversationId: "c1", staffId: "staff-A" });
  assert.equal(r.ok, true, "la asignación es por persona, no por dispositivo");
});

test("ASG04 — soltar solo funciona para quien la tiene", async () => {
  const pool = poolConUnaFila({ asignadaA: "staff-A" });
  const store = new NeonChatStore(pool);
  assert.equal((await store.releaseConversation({ conversationId: "c1", staffId: "staff-B" })).ok, false);
  assert.equal(pool.estado.asignadaA, "staff-A", "nadie le quita una conversación a quien la atiende");
  assert.equal((await store.releaseConversation({ conversationId: "c1", staffId: "staff-A" })).ok, true);
  assert.equal(pool.estado.asignadaA, null);
});

test("ASG05 — sin agente no se toma nada", async () => {
  const pool = poolConUnaFila();
  const r = await new NeonChatStore(pool).claimConversation({ conversationId: "c1", staffId: null });
  assert.equal(r.ok, false);
  assert.equal(pool.consultas.length, 0);
});

// --- Ventana de 24 h ------------------------------------------------------------------------

test("VEN01 — WhatsApp: dentro de 24 h sí, fuera no", () => {
  const ahora = new Date().toISOString();
  const casiVencida = new Date(Date.now() - VENTANA_WHATSAPP_MS + 60_000).toISOString();
  const vencida = new Date(Date.now() - VENTANA_WHATSAPP_MS - 60_000).toISOString();
  assert.equal(dentroDeLaVentana("whatsapp", ahora), true);
  assert.equal(dentroDeLaVentana("whatsapp", casiVencida), true);
  assert.equal(dentroDeLaVentana("whatsapp", vencida), false);
});

test("VEN02 — sin ningún mensaje entrante, WhatsApp está FUERA de ventana", () => {
  // La ventana la abre la clienta. Si nunca escribió, no hay ventana que valga -- tratarlo como
  // "dentro" haría que el sistema intente un texto libre que Meta va a descartar.
  assert.equal(dentroDeLaVentana("whatsapp", null), false);
  assert.equal(dentroDeLaVentana("whatsapp", "fecha inventada"), false);
});

test("VEN03 — el chat de la web no tiene ventana nunca", () => {
  assert.equal(dentroDeLaVentana("web", null), true);
  assert.equal(dentroDeLaVentana("web", new Date(0).toISOString()), true);
});

// Identificar a quien atiende NO es lo mismo que ser manicurista reservable. En app.staff,
// status='active' alimenta el catálogo de ReservApp y la disponibilidad: si la búsqueda del
// agente lo exigiera, la única forma de dejar atender a la dueña o a recepción sería ponerlas a
// la venta como manicuristas.
//
// Esto pasó de verdad el 2026-09-16: al exigir tomar la conversación antes de responder, la
// bandeja quedó bloqueada para TODO el mundo, y el arreglo evidente habría metido a gente en la
// lista de reservas de las clientas.
test("ASG06 — el agente se identifica por correo, sin exigir que sea manicurista activa", async () => {
  const consultas = [];
  const pool = {
    async query(sql, params) { consultas.push({ sql, params }); return { rows: [{ id: "staff-9" }] }; },
  };
  const id = await new NeonChatStore(pool).staffIdByEmail("Dalfi@Ejemplo.test");
  assert.equal(id, "staff-9");
  assert.doesNotMatch(consultas[0].sql, /status\s*=\s*'active'/,
    "exigir 'active' obliga a poner a la venta en ReservApp a quien solo atiende WhatsApp");
  assert.match(consultas[0].sql, /lower\(email\) = lower\(\$1\)/, "el correo no distingue mayúsculas");
});
