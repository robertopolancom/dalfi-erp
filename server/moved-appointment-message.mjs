// El texto que recibe por WhatsApp quien perdió la carrera por un horario.
//
// Vive aparte de server/app.mjs por una razón concreta: es la única pieza de todo el
// desplazamiento que lee una persona que no trabaja aquí, y la que más se va a retocar. Tenerla
// suelta permite probar lo que realmente importa -- que la frase del depósito solo aparezca
// cuando de verdad hay un depósito -- sin levantar el servidor entero.

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
               "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// "16/09" no se le escribe a nadie por WhatsApp. La cita movida cae siempre el mismo día que la
// original, que puede ser dentro de una semana, así que "hoy" tampoco sirve: hay que nombrar el
// día. La fecha ya viene en la zona del negocio (to_char en appointmentSummary); el mediodía es
// solo para que ningún cambio de horario la corra un día.
export function fechaEnPalabras(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(isoDate ?? "");
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
}

// Regla de Roberto (2026-09-14): "al que pagó y perdió se le queda la cita paga para
// recalendarizársela". El código ya la cumplía sin decirlo -- resolveDisplacedAppointments mueve
// la cita sin tocar deposit_status -- pero el cliente no tenía cómo saberlo, y esa es justo la
// pregunta que iba a llegar a la bandeja. Ahora se dice.
//
// Y se dice SOLO si hay algo que decir: a quien nunca depositó, hablarle de su depósito lo
// confunde, y a quien subió el comprobante pero todavía nadie lo ha revisado no se le puede
// prometer que está verificado. Por eso son tres textos y no uno.
function fraseDelDeposito(depositStatus) {
  if (depositStatus === "Verificado") return "Tu depósito sigue aplicado a esta cita, no se pierde.";
  if (depositStatus === "ComprobanteRecibido") return "Tu comprobante sigue guardado con esta cita, no hace falta enviarlo de nuevo.";
  return "";
}

export function buildMovedAppointmentMessage({ clientName, service, date, previousTime, newTime, depositStatus } = {}) {
  const partes = [
    `Hola ${clientName || ""}.`.replace(" .", "."),
    `Tu hora de las ${previousTime} se ocupó, y para no dejarte fuera movimos tu cita de ${service || "tu servicio"} al ${fechaEnPalabras(date)} a las ${newTime}, el mismo día.`,
    fraseDelDeposito(depositStatus),
    "Si te sirve, respóndenos por aquí y queda lista. Si no te viene bien, dinos y te buscamos otra hora.",
  ];
  return partes.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
