-- app.normalize_phone deja de asumir que todo número de 10 dígitos es dominicano.
--
-- El problema: la versión de la migración 0002 anteponía un "1" a cualquier número de diez
-- dígitos. Eso es correcto para República Dominicana (809/829/849 + 7 dígitos) pero diez
-- dígitos no son exclusivos de aquí: un móvil mexicano (55 1234 5678), uno colombiano
-- (300 123 4567) y uno francés (06 12 34 56 78) también tienen diez. A todos se les pegaba
-- un 1 delante y quedaban guardados como números dominicanos que no existen -- imposibles de
-- volver a encontrar y, si alguna vez se les escribiera por WhatsApp, imposibles de alcanzar.
--
-- El arreglo: cuando el número trae "+" o "00" delante YA viene con su código de país, así
-- que se respeta tal cual. El "1" solo se antepone cuando no hay ninguna señal de país y
-- quedan exactamente diez dígitos, que es el caso de siempre: el personal escribiendo un
-- número de aquí sin código.
--
-- Esta función es el espejo literal de normalizePhone() en server/phone.mjs. Si se cambia
-- una hay que cambiar la otra: si divergen, el mismo número tendría dos identidades según
-- lo normalizara Postgres o Node, y una ficha dejaría de enlazar con su conversación.
--
-- Sobre la compatibilidad con lo ya guardado: para cualquier número bien escrito el
-- resultado es IDÉNTICO al de antes. Solo cambian dos casos, y los dos estaban mal:
--   * los que traían prefijo "00" (antes quedaban con el 00 pegado, como 0018295590744);
--   * los que traían "+" y sumaban diez dígitos en total (antes recibían un 1 indebido).
-- Por eso no hay backfill aquí: reescribir phone_normalized en masa podría chocar contra el
-- índice único de app.client_phones. Si aparecen filas afectadas se corrigen a mano, y la
-- consulta para encontrarlas está al final de este archivo, comentada.
--
-- No hay ningún índice funcional ni columna generada sobre normalize_phone (comprobado en
-- todas las migraciones), así que redefinirla no invalida nada.

begin;

create or replace function app.normalize_phone(value text)
returns text
language sql
immutable
strict
as $$
  with limpio as (
    select
      btrim(value) as original,
      regexp_replace(value, '[^0-9]', '', 'g') as digitos
  ),
  con_pais as (
    select
      -- El "+" se busca en el texto original porque los dígitos ya no lo tienen. El "00" se
      -- busca en los dígitos para que "00 34 612..." y "0034612..." se traten igual.
      (original like '+%' or digitos like '00%') as trae_codigo_pais,
      case when digitos like '00%' then substr(digitos, 3) else digitos end as digitos
    from limpio
  )
  select case
    when digitos = '' then ''
    -- Solo se asume República Dominicana si no hay ninguna señal de país.
    when not trae_codigo_pais and length(digitos) = 10 then '1' || digitos
    else digitos
  end
  from con_pais
$$;

commit;

-- Filas cuyo phone_normalized guardado ya no coincide con la regla nueva. Debería salir
-- vacío; si sale algo, es de los dos casos rotos de arriba y se revisa uno por uno antes de
-- tocar nada (el índice único puede hacer que dos filas colapsen en el mismo número).
--
--   select id, client_id, phone_original, phone_normalized,
--          app.normalize_phone(phone_original) as seria_ahora
--     from app.client_phones
--    where phone_normalized is distinct from app.normalize_phone(phone_original);
