import { DATABASE_DOMAIN_TABLES } from "./database-authz.js";

// Extrae una vista estable de un dominio sin mutar el documento monolitico.
// Esta primera capa se usa para preparar la separacion gradual: mientras no
// exista una tabla propia, el origen sigue siendo erp_records.
export function extractDomainSlice(document, domain) {
  const source = document && typeof document === "object" ? document : {};
  const data = source.data && typeof source.data === "object" ? source.data : {};
  const tables = DATABASE_DOMAIN_TABLES[domain];
  if (!tables) return { domain, data: {}, unknownDomain: true };
  const slice = {};
  for (const table of tables) {
    if (Object.prototype.hasOwnProperty.call(data, table)) slice[table] = structuredClone(data[table]);
  }
  return { domain, data: slice, unknownDomain: false };
}

export function mergeDomainSlice(document, domain, sliceData) {
  const source = document && typeof document === "object" ? structuredClone(document) : {};
  source.data = source.data && typeof source.data === "object" ? source.data : {};
  const tables = DATABASE_DOMAIN_TABLES[domain];
  if (!tables) return { document: source, unknownDomain: true };
  const next = sliceData && typeof sliceData === "object" ? sliceData : {};
  for (const table of tables) {
    if (Object.prototype.hasOwnProperty.call(next, table)) source.data[table] = structuredClone(next[table]);
  }
  return { document: source, unknownDomain: false };
}
