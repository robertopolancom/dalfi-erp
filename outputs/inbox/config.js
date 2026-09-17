// Configuración pública de la bandeja. Aquí NO va ningún secreto:
//
//   * apiBase es una URL pública.
//   * La clave "publishable" de Supabase está pensada para ir en el navegador (es la misma que
//     sirve el ERP en supabase-config.js). Lo que protege los datos es la sesión del usuario y el
//     permiso que comprueba el servidor en cada llamada, no ocultar esta cadena.
//
// La clave de notificaciones NO está aquí a propósito: se pide a /api/push/public-key con sesión,
// para poder rotar el par VAPID sin volver a desplegar esta app.
window.DALFI_INBOX_CONFIG = {
  apiBase: "https://ssc.dalfistudio.com",
  supabaseUrl: "https://lcqxbhlkqtjlwsedarej.supabase.co",
  supabaseKey: "sb_publishable_By4TvJ5mz1bLHZ9nXVat5Q_hHLRGezI",
};
