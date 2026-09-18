// Prepara los archivos del ERP (outputs/) para producción. Corre SOLO al construir la imagen
// (Dockerfile -> npm run build), sobre la copia del contenedor: el repo sigue con el código
// legible, que es lo que leen las pruebas y lo que se edita.
//
// Dos cosas (Lighthouse, 2026-09-18):
//   1. Minifica app.js, lib/closing-math.js y styles.css con esbuild. app.js pasa de 206 a 136 KB
//      comprimido. Cada uno lleva su .map al lado, para depurar en el navegador con el código
//      original. lib/booking-engine.js NO se minifica: el servidor también lo importa
//      (server/legacy-booking-api.mjs) y no hay por qué tocar código que corre en el backend.
//   2. Pone en index.html un ?v= calculado del contenido de cada archivo. Antes era un texto
//      escrito a mano ("20260804-void-invoice...") que nadie actualizaba: app.js cambió muchas
//      veces después del 4 de agosto con el mismo ?v=. Con la versión sacada del contenido, el
//      servidor puede dejar esos archivos en caché un año (ver server/app.mjs): si cambian, cambia
//      la dirección y el navegador baja el nuevo.
//
// esbuild conserva los nombres de nivel superior en un script clásico (sin "format"), que es lo
// que necesitan app.js y closing-math.js: se comparten funciones a través de window.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { transformSync } from "esbuild";

const RAIZ = "outputs";
const MINIFICAR = ["app.js", "lib/closing-math.js", "styles.css"];
const VERSIONAR = ["app.js", "lib/closing-math.js", "lib/booking-engine.js", "styles.css", "supabase-config.js"];

for (const archivo of MINIFICAR) {
  const ruta = `${RAIZ}/${archivo}`;
  const fuente = readFileSync(ruta, "utf8");
  const nombre = archivo.split("/").pop();
  const { code, map } = transformSync(fuente, {
    loader: archivo.endsWith(".css") ? "css" : "js",
    minify: true,
    legalComments: "none",
    sourcemap: "external",
    sourcefile: nombre,
    sourcesContent: true,
  });
  const enlace = archivo.endsWith(".css") ? `/*# sourceMappingURL=${nombre}.map */` : `//# sourceMappingURL=${nombre}.map`;
  writeFileSync(ruta, `${code}${enlace}\n`);
  writeFileSync(`${ruta}.map`, map);
  console.log(`build-erp-assets: ${archivo} ${Math.round(fuente.length / 1024)} KB -> ${Math.round(code.length / 1024)} KB`);
}

let html = readFileSync(`${RAIZ}/index.html`, "utf8");
for (const archivo of VERSIONAR) {
  const hash = createHash("sha256").update(readFileSync(`${RAIZ}/${archivo}`)).digest("hex").slice(0, 12);
  const escapado = archivo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const patron = new RegExp(`((?:src|href)=")(?:\\./)?${escapado}(?:\\?v=[^"]*)?"`, "g");
  const antes = html;
  html = html.replace(patron, `$1${archivo}?v=${hash}"`);
  if (html === antes) throw new Error(`build-erp-assets: index.html no referencia ${archivo}; ¿cambió el nombre?`);
}
writeFileSync(`${RAIZ}/index.html`, html);
console.log("build-erp-assets: index.html con versiones por contenido");
