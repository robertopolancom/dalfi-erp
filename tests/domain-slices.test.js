const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const moduleUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "_lib", "domain-slices.js")).href;
const authzUrl = pathToFileURL(path.join(__dirname, "..", "functions", "api", "_lib", "database-authz.js")).href;

test("extractDomainSlice: inventario devuelve solo sus tablas y no muta el documento", async () => {
  const { extractDomainSlice } = await import(moduleUrl);
  const document = {
    data: {
      inventario: [{ itemID: "I-1", existencia: 4 }],
      ventasDirectas: [{ retailSaleId: "V-1" }],
      facturas: [{ facturaID: "F-1" }],
    },
  };
  const slice = extractDomainSlice(document, "inventario");
  assert.deepStrictEqual(slice.data, { inventario: [{ itemID: "I-1", existencia: 4 }], ventasDirectas: [{ retailSaleId: "V-1" }] });
  slice.data.inventario[0].existencia = 0;
  assert.equal(document.data.inventario[0].existencia, 4);
  assert.equal(Object.prototype.hasOwnProperty.call(slice.data, "facturas"), false);
});

test("mergeDomainSlice: solo reemplaza tablas del dominio y conserva los demas dominios", async () => {
  const { mergeDomainSlice } = await import(moduleUrl);
  const result = mergeDomainSlice(
    { data: { inventario: [{ itemID: "I-1" }], facturas: [{ facturaID: "F-1" }] } },
    "inventario",
    { inventario: [{ itemID: "I-2" }] },
  );
  assert.deepStrictEqual(result.document.data.inventario, [{ itemID: "I-2" }]);
  assert.deepStrictEqual(result.document.data.facturas, [{ facturaID: "F-1" }]);
  assert.equal(result.unknownDomain, false);
});

test("domain slices: un dominio desconocido nunca expone ni mezcla tablas", async () => {
  const { extractDomainSlice, mergeDomainSlice } = await import(moduleUrl);
  const document = { data: { inventario: [{ itemID: "I-1" }] } };
  assert.deepStrictEqual(extractDomainSlice(document, "desconocido"), { domain: "desconocido", data: {}, unknownDomain: true });
  const merged = mergeDomainSlice(document, "desconocido", { inventario: [{ itemID: "INJECTED" }] });
  assert.equal(merged.unknownDomain, true);
  assert.deepStrictEqual(merged.document.data, document.data);
});

test("domain slices: el mapa de dominios compartido sigue exportado por database-authz", async () => {
  const { DATABASE_DOMAIN_TABLES } = await import(authzUrl);
  assert.ok(DATABASE_DOMAIN_TABLES.inventario instanceof Set);
  assert.ok(DATABASE_DOMAIN_TABLES.inventario.has("ventasDirectas"));
  assert.ok(DATABASE_DOMAIN_TABLES.cuentas.has("transferencias"));
});
