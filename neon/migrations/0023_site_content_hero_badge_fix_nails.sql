-- Corrige el distintivo del hero: "Nail Studio" -> "Nails Studio" (el nombre del negocio es
-- Dalfi Studio NAILS, con S -- ver 0022_site_content_hero_badge.sql, que lo insertó sin la S).
update app.site_content
   set content = jsonb_set(content, '{hero,badge}', '"Nails Studio #1 en Baní"'::jsonb),
       updated_at = now(),
       updated_by = 'migration_0023_fix'
 where site_key = 'dalfistudionails'
   and content->'hero'->>'badge' = 'Nail Studio #1 en Baní';
