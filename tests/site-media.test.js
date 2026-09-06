import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const appMjs = readFileSync(new URL("../server/app.mjs", import.meta.url), "utf8");
const storeMjs = readFileSync(new URL("../server/store.mjs", import.meta.url), "utf8");
const migration = readFileSync(new URL("../neon/migrations/0025_site_media.sql", import.meta.url), "utf8");
const landingJs = readFileSync(new URL("../outputs/dalfistudionails/app.js", import.meta.url), "utf8");
const landingHtml = readFileSync(new URL("../outputs/dalfistudionails/index.html", import.meta.url), "utf8");
const landingHeaders = readFileSync(new URL("../outputs/dalfistudionails/_headers", import.meta.url), "utf8");
const erpJs = readFileSync(new URL("../outputs/app.js", import.meta.url), "utf8");

test("la subida está gateada por canManageConfiguration, y la lectura pública no", () => {
  const subir = appMjs.slice(appMjs.indexOf('app.post("/api/site-media/:siteKey"'));
  assert.match(subir.slice(0, 600), /requireErpPermission[\s\S]{0,200}canManageConfiguration/);
  const borrar = appMjs.slice(appMjs.indexOf('app.delete("/api/site-media/:siteKey/:id"'));
  assert.match(borrar.slice(0, 600), /requireErpPermission[\s\S]{0,200}canManageConfiguration/);
  // La ruta que SIRVE la imagen es pública a propósito: la consume la landing desde otro origen.
  const servir = appMjs.slice(appMjs.indexOf('app.get("/api/site-media/:id"'), appMjs.indexOf('app.get("/api/site-media/:siteKey/list"'));
  assert.ok(!servir.includes("requireErpPermission"), "servir la imagen no debe pedir sesión");
});

test("solo se admiten imágenes, y con un tope de tamaño real (no el largo del base64)", () => {
  assert.match(appMjs, /SITE_MEDIA_MIME_TYPES = new Set\(\["image\/jpeg", "image\/png", "image\/webp"\]\)/);
  assert.match(appMjs, /SITE_MEDIA_MAX_BYTES = 3 \* 1024 \* 1024/);
  // Se mide el peso real: el base64 infla un 33% y comparar su largo rechazaría fotos válidas.
  assert.match(appMjs, /Math\.floor\(\(imageBase64\.length \* 3\) \/ 4\)/);
  assert.match(appMjs, /res\.status\(413\)/);
});

test("la imagen se sirve cacheada para siempre porque su contenido nunca cambia", () => {
  assert.match(appMjs, /public, max-age=31536000, immutable/);
});

test("un id que no es uuid no llega a consultar la base", () => {
  const servir = appMjs.slice(appMjs.indexOf('app.get("/api/site-media/:id"'));
  const guard = servir.indexOf("UUID_RE.test");
  const consulta = servir.indexOf("getSiteMedia");
  assert.ok(guard !== -1 && guard < consulta, "el guard de uuid va antes de tocar la base");
});

test("borrar exige también el siteKey: un id suelto no basta", () => {
  // Sin el siteKey, quien administre un sitio podría borrar imágenes de otro.
  assert.match(storeMjs, /delete from app\.site_media where id=\$1 and site_key=\$2/);
});

test("la lista del panel nunca devuelve el contenido de las imágenes", () => {
  const lista = storeMjs.slice(storeMjs.indexOf("async listSiteMedia"), storeMjs.indexOf("async deleteSiteMedia"));
  assert.ok(!lista.includes("image_data"), "listar 20 fotos con su base64 serían megas de JSON por cada apertura del panel");
});

test("la migración crea la tabla y el índice sin romper si ya existen", () => {
  assert.match(migration, /create table if not exists app\.site_media/);
  assert.match(migration, /create index if not exists site_media_site_key_created_idx/);
  assert.match(migration, /id uuid primary key default gen_random_uuid\(\)/);
});

test("la landing solo sustituye la imagen si el contenido trae un id", () => {
  const fn = landingJs.slice(landingJs.indexOf("function applyImages"), landingJs.indexOf("function applyWhatsappLinks"));
  assert.match(fn, /if \(!value\) return;/, "sin valor guardado se queda la foto del HTML");
  assert.match(fn, /if \(!id\) return;/);
  assert.match(fn, /el\.src = mediaUrl\(id\)/);
});

test("la galería no se vacía si todavía nadie subió fotos", () => {
  const fn = landingJs.slice(landingJs.indexOf("function applyGalleryPhotos"), landingJs.indexOf("function applyLists"));
  assert.match(fn, /if \(!grid \|\| !photos\.length\) return;/);
  // El innerHTML = "" tiene que ir DESPUÉS de ese guard, o borraría la galería estática.
  assert.ok(fn.indexOf("!photos.length") < fn.indexOf('grid.innerHTML = ""'));
});

test("las cinco imágenes de sección están marcadas en el HTML y bajo content.images", () => {
  for (const key of ["images.hero", "images.heroInset", "images.about", "images.services", "images.contact"]) {
    assert.ok(landingHtml.includes(`data-cms-img="${key}"`), `falta ${key} en el HTML`);
  }
  // Nunca dentro de la sección: `services` es un array y escribirle una propiedad lo rompe.
  assert.ok(!landingHtml.includes('data-cms-img="services.image"'));
  assert.match(erpJs, /content\.images = \{\}/);
});

test("el CSP de la landing deja cargar imágenes del ERP", () => {
  assert.match(landingHeaders, /img-src 'self' data: https:\/\/ssc\.dalfistudio\.com/);
});

test("el panel redimensiona antes de subir", () => {
  assert.match(erpJs, /SITE_IMAGE_MAX_DIMENSION = 1600/);
  assert.match(erpJs, /canvas\.toDataURL\("image\/jpeg", SITE_IMAGE_JPEG_QUALITY\)/);
});

test("reordenar o quitar una foto no pierde lo escrito en los campos", () => {
  const fn = erpJs.slice(erpJs.indexOf("function wireSitePhotoControls"), erpJs.indexOf("function renderSiteContentGalleryList"));
  // syncSitePhotosFromDom() rescata caption/alt/wide del DOM antes de repintar la lista.
  assert.ok(fn.indexOf("syncSitePhotosFromDom()") < fn.indexOf("pendingSitePhotos.splice"));
});
