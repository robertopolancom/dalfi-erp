// Avisos de seguridad por correo.
//
// Hasta el 2026-09-18, si alguien probaba cientos de contraseñas o de códigos de WhatsApp contra
// ReservApp, el limitador lo frenaba y quedaba en los registros de Cloud Run -- pero nadie se
// enteraba. Esto cuenta los intentos sospechosos y, si en poco tiempo pasan de un umbral, manda un
// correo a administración.
//
// Por qué vive en el servidor y no como alerta de Google Cloud: funciona igual en cualquier sitio
// donde corra el ERP, no depende de configurar nada a mano en la consola, y usa el mismo envío de
// correo que ya usan las facturas. Además cada evento se escribe como una línea JSON con
// severity WARNING, así que si algún día se quiere una alerta en Cloud Logging, ya hay qué contar.
//
// Límites que conviene conocer:
//   - Los contadores viven en la memoria de cada instancia. Con varias instancias a la vez cada
//     una cuenta lo suyo, así que un ataque repartido tarda algo más en disparar el aviso. Para
//     un salón es suficiente; no hace falta una base de datos para esto.
//   - Tras un aviso de un tipo, ese tipo calla una hora. Un ataque largo no tiene que llenarle el
//     buzón a nadie: con saber que está pasando basta.
//   - En el correo y en los registros va la IP y la ruta. Nunca teléfonos, contraseñas, códigos
//     ni secretos: el aviso no puede convertirse en otra fuga.

export const TIPOS = {
  intentos_bloqueados: {
    umbral: 20,
    titulo: "Muchas peticiones bloqueadas por exceso de intentos",
    explicacion: "Alguien está haciendo demasiadas peticiones seguidas a ReservApp y el limitador lo está frenando. Puede ser un ataque automatizado o un error en algún programa.",
  },
  login_fallido: {
    umbral: 15,
    titulo: "Muchos intentos de acceso fallidos en ReservApp",
    explicacion: "Se están probando contraseñas equivocadas. Si son muchas desde la misma IP, lo más probable es que alguien esté intentando adivinar contraseñas.",
  },
  codigo_fallido: {
    umbral: 15,
    titulo: "Muchos códigos de WhatsApp equivocados",
    explicacion: "Se están probando códigos de verificación incorrectos. Cada código se bloquea solo tras unos pocos fallos, pero una cantidad alta indica que alguien está probando a ciegas.",
  },
  secreto_invalido: {
    umbral: 5,
    titulo: "Llamadas internas con un secreto incorrecto",
    explicacion: "Alguien está llamando a rutas que solo usan el bot o las tareas programadas, con un secreto equivocado. Puede ser alguien tanteando el sistema, o un secreto que cambió en un lado y no en el otro.",
  },
};

const VENTANA_MS = 10 * 60 * 1000;
const SILENCIO_MS = 60 * 60 * 1000;
const MAX_EVENTOS_POR_TIPO = 500;

export function crearVigilante({
  env = {},
  enviarCorreo,
  logger = console,
  ahora = () => Date.now(),
} = {}) {
  const eventos = new Map(); // tipo -> [{ t, ip, ruta }]
  const ultimoAviso = new Map(); // tipo -> t

  function destinatarios() {
    const lista = String(env.SECURITY_ALERT_EMAIL || env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.includes("@"));
    // Sin nadie configurado se manda al buzón del propio negocio (comportamiento por defecto de
    // sendBusinessEmail sin destinatario), para que el aviso llegue a alguien siempre.
    return lista.length ? lista : [null];
  }

  function correo(tipo, recientes) {
    const cfg = TIPOS[tipo];
    const porIp = new Map();
    for (const e of recientes) porIp.set(e.ip, (porIp.get(e.ip) || 0) + 1);
    const top = [...porIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const rutas = [...new Set(recientes.map((e) => e.ruta).filter(Boolean))].slice(0, 5);
    const cuando = new Date(ahora()).toLocaleString("es-DO", { timeZone: "America/Santo_Domingo" });
    const lineasIp = top.map(([ip, n]) => `  ${ip}: ${n}`).join("\n");
    const text = [
      `${cfg.titulo}`,
      "",
      `${recientes.length} en los últimos 10 minutos (aviso a partir de ${cfg.umbral}). ${cuando}.`,
      "",
      cfg.explicacion,
      "",
      "Desde dónde:",
      lineasIp,
      "",
      `Rutas: ${rutas.join(", ") || "-"}`,
      "",
      "No hace falta hacer nada si fue un caso aislado: el sistema ya está bloqueando. Si se repite o viene de muchas IP distintas, conviene revisarlo.",
      "Este tipo de aviso queda en silencio una hora para no llenar el buzón.",
    ].join("\n");
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#211F1B;max-width:560px">
<p style="font-weight:600;color:#A5583F">${esc(cfg.titulo)}</p>
<p><strong>${recientes.length}</strong> en los últimos 10 minutos (aviso a partir de ${cfg.umbral}). ${esc(cuando)}.</p>
<p>${esc(cfg.explicacion)}</p>
<p style="margin-bottom:4px">Desde dónde:</p>
<ul style="margin-top:0">${top.map(([ip, n]) => `<li>${esc(ip)}: ${n}</li>`).join("")}</ul>
<p>Rutas: ${esc(rutas.join(", ") || "-")}</p>
<p style="color:#726C60;font-size:13px">No hace falta hacer nada si fue un caso aislado: el sistema ya está bloqueando. Si se repite o viene de muchas IP distintas, conviene revisarlo. Este tipo de aviso queda en silencio una hora para no llenar el buzón.</p>
</div>`;
    return { subject: `Aviso de seguridad: ${cfg.titulo}`, text, html };
  }

  function registrar(tipo, { ip = "desconocida", ruta = "" } = {}) {
    const cfg = TIPOS[tipo];
    if (!cfg) return { avisado: false };
    const t = ahora();

    // Línea estructurada para Cloud Logging. Sin datos personales.
    try {
      logger.warn(JSON.stringify({ severity: "WARNING", evento: "seguridad", tipo, ip, ruta }));
    } catch { /* un log roto nunca puede tumbar la petición */ }

    const lista = (eventos.get(tipo) || []).filter((e) => t - e.t < VENTANA_MS);
    lista.push({ t, ip, ruta });
    if (lista.length > MAX_EVENTOS_POR_TIPO) lista.splice(0, lista.length - MAX_EVENTOS_POR_TIPO);
    eventos.set(tipo, lista);

    if (lista.length < cfg.umbral) return { avisado: false };
    const previo = ultimoAviso.get(tipo);
    if (previo && t - previo < SILENCIO_MS) return { avisado: false };
    ultimoAviso.set(tipo, t);

    if (typeof enviarCorreo === "function") {
      const mensaje = correo(tipo, lista);
      for (const to of destinatarios()) {
        Promise.resolve()
          .then(() => enviarCorreo({ ...mensaje, ...(to ? { to } : {}) }))
          .catch((error) => logger.error("seguridad: no se pudo enviar el aviso --", error?.message || error));
      }
    }
    return { avisado: true };
  }

  return { registrar };
}
