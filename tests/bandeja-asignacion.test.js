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
import { readFile } from "node:fs/promises";
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

// El mismo error, en el sitio donde no se nota: a quién se avisa.
//
// Pasó de verdad el 2026-09-16, unas horas después de ASG06. staffIdByEmail ya no exigía
// status='active', así que quien tiene la ficha inactiva (todo el que atiende y no es manicurista
// reservable) podía tomar conversaciones y responder con normalidad... y no recibía NINGUNA
// notificación de una conversación sin tomar, que es la única que hace falta de verdad. El aviso
// no fallaba: simplemente no tenía a quién mandarlo, y eso no produce ni un error en los logs.
test("ASG07 — el aviso llega a quien tiene suscripción, sea o no manicurista reservable", async () => {
  const consultas = [];
  const pool = {
    async query(sql, params) {
      consultas.push({ sql, params });
      return { rows: [{ id: "sub-1", endpoint: "https://fcm.test/x", p256dh: "p", auth: "a" }] };
    },
  };
  const destinos = await new NeonChatStore(pool).pushTargetsForConversation("conv-1");
  assert.deepEqual(destinos, [{ id: "sub-1", endpoint: "https://fcm.test/x", keys: { p256dh: "p", auth: "a" } }]);
  assert.doesNotMatch(consultas[0].sql, /status\s*=\s*'active'/,
    "la ficha inactiva es lo normal en quien atiende desde la oficina: filtrar por eso lo deja sin avisos");
  // Y la regla que sí importa tiene que seguir en pie: si ya la atiende alguien, solo a esa
  // persona. Interrumpir a todo el equipo por algo ya atendido es cómo se deja de mirar los avisos.
  assert.match(consultas[0].sql, /assigned_staff_id is null or ps\.user_id = c\.assigned_staff_id/);
});

// El nombre del estado pausado vive en UN solo sitio. Es un espejo de STATES.ATENCION_HUMANA en
// el motor del bridge: si el ERP y el motor se separan, la bandeja dice una cosa y el bot hace
// otra. Por eso el booleano se calcula en el servidor y no se repite la cadena en dos pantallas.
test("ASG08 — el servidor dice si el bot está en pausa; el navegador no repite la cadena", async () => {
  const fuenteStore = await readFile(new URL("../server/store.mjs", import.meta.url), "utf8");
  const apariciones = fuenteStore.match(/botPausado: row\.bot_state === BOT_PAUSADO_POR_PERSONA/g) || [];
  assert.equal(apariciones.length, 2, "la lista y el hilo, los dos");

  for (const archivo of ["../outputs/inbox/app.js", "../outputs/app.js"]) {
    const fuente = await readFile(new URL(archivo, import.meta.url), "utf8");
    const codigo = fuente.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(codigo, /ATENCION_HUMANA/,
      `${archivo} no debe conocer el nombre interno del estado del motor`);
    assert.match(codigo, /botPausado/, `${archivo} tiene que usar el booleano del servidor`);
  }
});

// LA REGLA: solo dos estados, nunca un tercero. O la atiende un asesor, o la atiende el bot.
// Una conversación sin dueño y con el motor en pausa no es un estado válido: es un cliente
// escribiéndole al vacío, y no produce ningún error en ninguna parte.
test("ASG09 — soltar devuelve el turno al bot, no deja la conversación muda", async () => {
  const consultas = [];
  const pool = {
    async query(sql, params) { consultas.push({ sql, params }); return { rowCount: 1, rows: [] }; },
  };
  await new NeonChatStore(pool).releaseConversation({ conversationId: "c1", staffId: "s1" });
  assert.match(consultas[0].sql, /bot_state = null/,
    "sin esto el motor sigue en pausa y la conversación no la atiende nadie");
  assert.doesNotMatch(consultas[0].sql, /needs_human/,
    "soltar es 'que la coja otro', no 'ya está resuelto': la petición de asesor se conserva");
  assert.match(consultas[0].sql, /assigned_staff_id = \$2/, "solo puede soltar quien la tiene");
});

test("ASG10 — cerrar y devolver al bot limpian el espejo del motor", async () => {
  // bot_state es un ESPEJO de STATES.ATENCION_HUMANA en el motor. Solo lo limpiaba la
  // reanudación automática, así que al cerrar a mano la columna se quedaba diciendo "en pausa"
  // en una conversación que el bot atendía con toda normalidad.
  for (const metodo of ["closeConversation", "returnToBot"]) {
    const consultas = [];
    const pool = { async query(sql) { consultas.push(sql); return { rowCount: 1, rows: [] }; } };
    await new NeonChatStore(pool)[metodo]({ conversationId: "c1", staffId: "s1" });
    assert.match(consultas[0], /bot_state = null/, `${metodo} deja el espejo desfasado`);
    assert.match(consultas[0], /needs_human = false/, `${metodo} da la atención por terminada`);
  }
});

test("ASG11 — queda escrito que una ficha activa no significa que deba atender", async () => {
  // El error que quedaba por cometer es el simétrico del de ASG06: ver una manicurista con ficha
  // activa y sin correo, pensar que es un dato incompleto, y "completarlo". Eso le abre la
  // bandeja entera -- nombres y teléfonos de todas las clientas -- a alguien cuyo trabajo no es
  // atender. Las manicuristas no atienden: atienden la administradora y el personal de apoyo.
  const fuente = await readFile(new URL("../server/store.mjs", import.meta.url), "utf8");
  const nota = fuente.slice(0, fuente.indexOf("async staffIdByEmail"));
  assert.match(nota, /manicuristas no atienden/i,
    "la regla no está en ningún sitio del código si no está aquí");
  assert.match(nota, /canManageReservations/,
    "hay que decir dónde se decide de verdad quién atiende");
});
