begin;

-- El setup de credenciales (clienta autorregistrándose, o colaboradora invitada por una
-- administradora) pasó de ser un enlace mágico de un solo paso a un código de 6 dígitos en dos
-- pasos: 1) verificar que la persona controla ese teléfono, 2) fijar la contraseña. La misma
-- fila de reservapp_setup_tokens se reutiliza para ambos pasos -- token_hash guarda primero el
-- hash del código, y al verificarlo correctamente se ROTA a un secreto nuevo que el paso 2
-- consume (ver server/store.mjs: verifySetupOtp, activateWithToken). Un código de 6 dígitos es
-- adivinable en pocos intentos si no se limita, a diferencia del token largo original -- por
-- eso hace falta el conteo de intentos que reservapp_relay_otps ya usa para el mismo problema.
alter table app.reservapp_setup_tokens
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempts integer not null default 5;

commit;
