import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// appointmentSummary() es de donde salen los datos de TRES avisos por correo: comprobante de
// depósito subido, cita cancelada y confirmación de la clienta. Agrupaba por a.legacy_id -- que
// no es la clave primaria -- mientras usaba a.starts_at en el select, así que Postgres la
// rechazaba SIEMPRE con 'column "a.starts_at" must appear in the GROUP BY clause'. Los tres
// avisos morían ahí, antes siquiera de intentar mandar nada. Se vio el 2026-09-06 a las 18:40,
// cuando cancelar una cita dejó por fin el error en el log.
const storeMjs = readFileSync(new URL("../server/store.mjs", import.meta.url), "utf8");

function summaryQuery() {
  const start = storeMjs.indexOf("async appointmentSummary");
  assert.ok(start !== -1, "no se encontró appointmentSummary");
  const body = storeMjs.slice(start, storeMjs.indexOf("\n  }", start));
  const from = body.indexOf("`select");
  return body.slice(from, body.indexOf("`,", from));
}

test("toda columna de `a` que se selecciona sin agregar está en el GROUP BY", () => {
  const query = summaryQuery();
  const groupBy = query.slice(query.indexOf("group by"));
  const select = query.slice(0, query.indexOf("from app.appointments"));

  // Columnas de la tabla `a` que aparecen en el select. string_agg es lo único agregado, y va
  // sobre `x`, no sobre `a`.
  const usadas = [...new Set([...select.matchAll(/\ba\.(\w+)/g)].map((m) => m[1]))];
  assert.ok(usadas.includes("starts_at"), "la prueba dejaría de valer si ya no se usa starts_at");

  for (const columna of usadas) {
    assert.match(groupBy, new RegExp(`\\ba\\.${columna}\\b`),
      `a.${columna} se selecciona sin agregar pero falta en el GROUP BY: Postgres rechaza la consulta entera`);
  }
});

test("se agrupa por la clave primaria, no solo por legacy_id", () => {
  const groupBy = summaryQuery().slice(summaryQuery().indexOf("group by"));
  assert.match(groupBy, /\ba\.id\b/,
    "agrupar por a.id deja que Postgres reconozca la dependencia funcional del resto de columnas de a");
});

test("las columnas de las otras tablas siguen agrupadas", () => {
  // c, s y bs entran por join/cross join: su dependencia funcional NO la da a.id, así que tienen
  // que seguir listadas una a una.
  const groupBy = summaryQuery().slice(summaryQuery().indexOf("group by"));
  for (const columna of ["c.full_name", "s.full_name", "bs.timezone"]) {
    assert.ok(groupBy.includes(columna), `falta ${columna} en el GROUP BY`);
  }
});
