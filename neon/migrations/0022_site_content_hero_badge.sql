-- Agrega el distintivo del hero ("Nail Studio #1 en Baní") al contenido ya existente --
-- merge con jsonb || dentro de "hero" para no pisar el resto de sus campos.
update app.site_content
   set content = jsonb_set(content, '{hero,badge}', '"Nail Studio #1 en Baní"'::jsonb),
       updated_at = now(),
       updated_by = 'migration_0022_seed'
 where site_key = 'dalfistudionails'
   and not (content->'hero' ? 'badge');
