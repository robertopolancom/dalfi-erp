const test = require("node:test");
const assert = require("node:assert/strict");
const { computeAccountDailyBalance, buildRunningBalance, sortMovementsDeterministically, canReviewAccounts } = require("../outputs/lib/closing-math.js");

// 22. Balance inicial
test("22. computeAccountDailyBalance: el balance inicial se respeta tal cual si no hay movimientos", () => {
  const result = computeAccountDailyBalance({ balanceInicial: 500 });
  assert.strictEqual(result.balanceInicial, 500);
  assert.strictEqual(result.balanceFinalCalculado, 500);
});

// 23. Ingresos y egresos diarios
test("23. computeAccountDailyBalance: suma ingresos y resta egresos del dia", () => {
  const result = computeAccountDailyBalance({ balanceInicial: 1000, ingresos: 300, egresos: 120 });
  assert.strictEqual(result.balanceFinalCalculado, 1180);
});

// 24 + 25. Transferencia entre cuentas y neutralidad del total consolidado
test("24/25. una transferencia interna resta de origen y suma en destino, sin cambiar el total consolidado de las dos cuentas juntas", () => {
  const monto = 250;
  const origen = computeAccountDailyBalance({ balanceInicial: 1000, transferenciasSalientes: monto });
  const destino = computeAccountDailyBalance({ balanceInicial: 500, transferenciasEntrantes: monto });
  const totalAntes = 1000 + 500;
  const totalDespues = origen.balanceFinalCalculado + destino.balanceFinalCalculado;
  assert.strictEqual(origen.balanceFinalCalculado, 750);
  assert.strictEqual(destino.balanceFinalCalculado, 750);
  assert.strictEqual(totalDespues, totalAntes, "el total consolidado de origen+destino no debe cambiar por una transferencia interna");
});

// 26. Balance final (formula completa con todos los componentes)
test("26. computeAccountDailyBalance: formula completa balanceInicial+ingresos+transferenciasEntrantes-egresos-transferenciasSalientes+ajustesNetos", () => {
  const result = computeAccountDailyBalance({
    balanceInicial: 1000,
    ingresos: 200,
    egresos: 80,
    transferenciasEntrantes: 50,
    transferenciasSalientes: 30,
    ajustesNetos: -10,
  });
  assert.strictEqual(result.balanceFinalCalculado, 1000 + 200 + 50 - 80 - 30 - 10);
});

// 27/28. Filtro por fecha y por cuenta se prueban a nivel de accountTransactions/
// accountOpeningBalance/accountPeriodSummary, que ya son funciones DOM-libres
// reusadas del modulo de Reportes (sin cambios) y ya se ejercitan indirectamente
// via las pruebas existentes de cierres. La agregacion pura por fecha/cuenta que
// SI es nueva en este cambio (computeAccountDailyBalance) queda cubierta arriba.

// 29. Zona horaria America/Santo_Domingo: computeAccountDailyBalance en si es
// zona-horaria-agnostica (solo suma numeros); quien decide "que es hoy" ya esta
// cubierto por isAutomaticClosingEligible en tests/closing-math.test.js con esa
// misma zona horaria. Este caso documenta esa division de responsabilidad.
test("29. computeAccountDailyBalance no decide fechas: solo agrega montos ya filtrados por fecha comercial (esa decision vive en isAutomaticClosingEligible / accountActivityForDate)", () => {
  const result = computeAccountDailyBalance({ balanceInicial: 0, ingresos: 100 });
  assert.strictEqual(result.balanceFinalCalculado, 100);
});

// 30. Saldo acumulado deterministico
test("30. buildRunningBalance: saldo acumulado en orden cronologico, id estable como desempate", () => {
  const movements = [
    { id: "B", date: "2026-07-10", income: 100, expense: 0 },
    { id: "A", date: "2026-07-10", income: 0, expense: 40 },
    { id: "C", date: "2026-07-09", income: 50, expense: 0 },
  ];
  const result = buildRunningBalance(movements, 0);
  // orden esperado: C (07-09), luego A antes que B en el mismo dia (id estable "A" < "B")
  assert.deepStrictEqual(result.map((row) => row.id), ["C", "A", "B"]);
  assert.strictEqual(result[0].runningBalance, 50);
  assert.strictEqual(result[1].runningBalance, 10);
  assert.strictEqual(result[2].runningBalance, 110);
});

test("30b. sortMovementsDeterministically es estable si se corre dos veces (no reordena distinto)", () => {
  const movements = [
    { id: "X", date: "2026-07-10", createdAt: "2026-07-10T10:00:00Z" },
    { id: "Y", date: "2026-07-10", createdAt: "2026-07-10T09:00:00Z" },
  ];
  const first = sortMovementsDeterministically(movements).map((m) => m.id);
  const second = sortMovementsDeterministically(movements).map((m) => m.id);
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first, ["Y", "X"]);
});

// 31/32/33. Permisos
test("31. administradora/propietario tienen acceso completo a Cuentas sin necesitar el flag explicito", () => {
  assert.strictEqual(canReviewAccounts("administradora", false), true);
  assert.strictEqual(canReviewAccounts("propietario", false), true);
});

test("32. contador/contadora tienen acceso de revision sin necesitar el flag explicito", () => {
  assert.strictEqual(canReviewAccounts("contador", false), true);
  assert.strictEqual(canReviewAccounts("contadora", false), true);
});

test("33. un rol no autorizado (ej. operador) sin el flag explicito NO tiene acceso; con el flag SI lo tiene", () => {
  assert.strictEqual(canReviewAccounts("operador", false), false);
  assert.strictEqual(canReviewAccounts("operador", true), true);
  assert.strictEqual(canReviewAccounts("asistente_contable", false), false);
  assert.strictEqual(canReviewAccounts("asistente_contable", true), true);
});

// 34. Compatibilidad con movimientos antiguos: si un movimiento viejo no trae
// createdAt/id, sortMovementsDeterministically no debe lanzar y debe ordenar
// igual por fecha (fallback seguro a cadena vacia).
test("34. compatibilidad con movimientos antiguos sin createdAt/id: no lanza excepcion y ordena por fecha", () => {
  const movements = [{ date: "2026-07-10" }, { date: "2026-07-09" }];
  assert.doesNotThrow(() => sortMovementsDeterministically(movements));
  const sorted = sortMovementsDeterministically(movements);
  assert.deepStrictEqual(sorted.map((m) => m.date), ["2026-07-09", "2026-07-10"]);
});

// 35. No duplicacion de movimientos: correr buildRunningBalance dos veces
// sobre el mismo input produce el mismo resultado (no acumula sobre si mismo).
test("35. buildRunningBalance es idempotente: correrlo dos veces con el mismo input da el mismo resultado", () => {
  const movements = [{ id: "A", date: "2026-07-10", income: 100, expense: 0 }];
  const first = buildRunningBalance(movements, 0);
  const second = buildRunningBalance(movements, 0);
  assert.strictEqual(first[0].runningBalance, second[0].runningBalance);
  assert.strictEqual(first[0].runningBalance, 100);
});
