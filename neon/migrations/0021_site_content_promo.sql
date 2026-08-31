-- Agrega el campo "promo" (barra de descuento arriba de la página) al contenido ya existente de
-- dalfistudionails -- merge con jsonb || para no pisar ningún otro campo que ya se haya editado
-- desde el panel "Página web" del ERP desde que se activó (ver 0020_site_content.sql).
update app.site_content
   set content = content || '{
     "promo": {
       "enabled": true,
       "text": "15% de descuento en tu cita, reservando por esta página o por ReservApp."
     }
   }'::jsonb,
   updated_at = now(),
   updated_by = 'migration_0021_seed'
 where site_key = 'dalfistudionails'
   and not (content ? 'promo');
