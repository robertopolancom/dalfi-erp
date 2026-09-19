// RNC y cédula dominicanos: normalización y dígito verificador.
//
// Para un e-CF de crédito fiscal (E31) el comprador tiene que tener RNC (9 dígitos) o cédula
// (11 dígitos) válidos. Esto solo comprueba que el número esté bien formado (dígito verificador);
// que exista y esté activo en el padrón de la DGII es otra consulta, que hará el PSFE al emitir.
//
// Algoritmos públicos de la DGII y la JCE:
//   - RNC: pesos 7,9,8,6,5,4,3,2 sobre los 8 primeros dígitos; resto = suma % 11;
//     verificador = 2 si el resto es 0, 1 si es 1, y 11 - resto en los demás casos.
//   - Cédula: pesos 1,2 alternados sobre los 10 primeros; si un producto pasa de 9 se suman sus
//     dígitos (se le resta 9); verificador = (10 - suma % 10) % 10.

export function soloDigitos(valor) {
  return String(valor || "").replace(/\D/g, "");
}

export function rncValido(valor) {
  const d = soloDigitos(valor);
  if (d.length !== 9) return false;
  const pesos = [7, 9, 8, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, peso, i) => acc + peso * Number(d[i]), 0);
  const resto = suma % 11;
  const verificador = resto === 0 ? 2 : resto === 1 ? 1 : 11 - resto;
  return verificador === Number(d[8]);
}

export function cedulaValida(valor) {
  const d = soloDigitos(valor);
  if (d.length !== 11) return false;
  let suma = 0;
  for (let i = 0; i < 10; i += 1) {
    let producto = Number(d[i]) * (i % 2 === 0 ? 1 : 2);
    if (producto > 9) producto -= 9;
    suma += producto;
  }
  return (10 - (suma % 10)) % 10 === Number(d[10]);
}

// Devuelve { ok, tipo: "RNC" | "Cedula", numero } o { ok: false, error }.
export function validarIdentificacionFiscal(valor) {
  const numero = soloDigitos(valor);
  if (numero.length === 9) return rncValido(numero) ? { ok: true, tipo: "RNC", numero } : { ok: false, error: "El RNC no es válido (revisa los 9 dígitos)." };
  if (numero.length === 11) return cedulaValida(numero) ? { ok: true, tipo: "Cedula", numero } : { ok: false, error: "La cédula no es válida (revisa los 11 dígitos)." };
  return { ok: false, error: "Escribe un RNC de 9 dígitos o una cédula de 11." };
}
