# Publicación gratuita del ERP

Ruta recomendada:

1. GitHub para guardar el código.
2. Supabase para base de datos y usuarios.
3. Vercel o Netlify para publicar la aplicación web.

## Fase 1 - Subir código a GitHub

1. Crear un repositorio nuevo en GitHub.
2. Nombre sugerido: `dalfi-erp`.
3. No agregar README ni .gitignore desde GitHub, porque este proyecto ya los prepara localmente.
4. Copiar la URL del repositorio.

Comandos locales:

```bash
git init
git add .
git commit -m "Primera version ERP Dalfi"
git branch -M main
git remote add origin URL_DEL_REPOSITORIO
git push -u origin main
```

## Fase 2 - Publicar gratis en Vercel

1. Entrar a https://vercel.com.
2. Iniciar sesión con GitHub.
3. New Project.
4. Seleccionar el repositorio `dalfi-erp`.
5. En Environment Variables agregar:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
6. Deploy.

Este proyecto incluye `vercel.json` para ejecutar el build y servir la app desde la carpeta `outputs`. Los usuarios solo inician sesión con correo y contraseña; no deben configurar URL ni claves en sus dispositivos.

## Fase 3 - Alternativa Netlify

1. Entrar a https://netlify.com.
2. Add new site from Git.
3. Seleccionar GitHub y el repositorio.
4. Publish directory: `outputs`.
5. Deploy.

Este proyecto incluye `netlify.toml`.

## Fase 4 - Supabase

Para usarlo en varios dispositivos con los mismos datos, hay que conectar la app a Supabase.

1. Crear proyecto en Supabase.
2. Abrir SQL Editor.
3. Ejecutar el archivo `supabase/schema.sql`.
4. Luego crear credenciales públicas para la app.
5. Modificar `outputs/app.js` para leer y guardar en Supabase en vez de solo localStorage/database.json.

## Advertencia importante

La publicación estática en Vercel o Netlify permite abrir la app desde celulares, tablets y computadoras. Pero mientras la app siga usando `localStorage`, cada dispositivo tendrá datos separados.

Para operación real del negocio, la siguiente fase obligatoria es conectar Supabase.
