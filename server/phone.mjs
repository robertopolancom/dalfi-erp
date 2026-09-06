// Normalización de teléfonos: la identidad con la que el ERP reconoce a una persona.
//
// Por qué existe este archivo: la misma regla estaba copiada en cuatro sitios (el store,
// la autenticación de ReservApp, la API vieja de reservas y la función app.normalize_phone
// de Postgres). Cuatro copias de una regla es exactamente como se produce una divergencia:
// basta con arreglar un caso en una y el mismo número pasa a tener dos identidades, la ficha
// deja de enlazar con su conversación y nadie entiende por qué. Ahora hay una sola en JS, y
// la de Postgres (migración 0027) es su espejo literal -- si tocas una, toca la otra.
//
// La regla, y el motivo de cada parte:
//
//   1. Se descartan todos los caracteres que no sean dígitos. El "+", los guiones, los
//      paréntesis y los espacios son formato, no identidad: (829) 559-0744 y 8295590744
//      son la misma persona.
//
//   2. Un "+" delante, o un "00" delante, significan que el número YA trae su código de
//      país. Son la misma señal escrita de dos formas: "+" es la notación E.164 y "00" es
//      el prefijo internacional que se marca desde un teléfono en casi toda Europa y
//      Latinoamérica. Cuando esa señal está, el número se respeta tal cual.
//
//   3. Solo cuando NO hay señal de país y quedan exactamente 10 dígitos se antepone el 1.
//      Es la convención local: un número dominicano es 809/829/849 + 7 dígitos, y el
//      personal lo escribe a diario sin código de país. Diez dígitos pelados aquí significan
//      "número de aquí".
//
// El punto 2 es el que hace que esto funcione fuera de República Dominicana, y la razón es
// que 10 dígitos NO son exclusivos del plan de numeración norteamericano: un móvil mexicano
// (55 1234 5678), uno colombiano (300 123 4567) y uno francés (06 12 34 56 78) también
// tienen diez. Sin mirar el "+" no hay forma de distinguirlos, y todos acababan con un 1
// delante que los convertía en un número dominicano inexistente.
//
// Lo que esto NO puede resolver, y conviene saberlo: un número extranjero escrito SIN "+"
// ni "00" es indistinguible de uno local. "5512345678" seguirá tratándose como dominicano,
// porque no hay ningún dato en la cadena que diga lo contrario. Para que un número de fuera
// se guarde bien hay que escribirlo con su "+", que es justamente lo que ahora se respeta.

/**
 * Devuelve la forma canónica del teléfono: solo dígitos, con código de país.
 * Cadena vacía si no había ningún dígito -- nunca lanza, para que las búsquedas por
 * teléfono puedan pasarle lo que sea que haya escrito una persona.
 */
export function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  let digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  // "+" y "00" son la misma señal. Se comprueba el "00" sobre los dígitos y no sobre el
  // texto original para que "00 34 612..." y "0034612..." se traten igual.
  const traeCodigoPais = raw.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (!traeCodigoPais && digits.length === 10) return `1${digits}`;
  return digits;
}
