# Pendientes con disparador

Dos cosas que **no** se hacen todavía, cada una esperando algo concreto. Están
aquí escritas al detalle para que cuando llegue el momento sea ejecutar, no
reconstruir el razonamiento.

Escrito el 2026-09-04, al terminar la migración a `dalfistudio.com`.

---

## 1. Cerrar el corte limpio de `sebengroup.com`

**Disparador:** que Meta apruebe la verificación de empresa.
**Duración:** unos dos minutos.
**Estado al 2026-09-04:** "En revisión" en el panel de Meta.

### Por qué quedó a medias

El corte limpio del 2026-09-04 sacó de `sebengroup.com` cuatro de los cinco
hostnames de Dalfi: `reservapp`, `ssc`, `crm` y `bot`. El quinto,
**`dalfistudionails.sebengroup.com`, se dejó vivo a propósito**.

La verificación de empresa de Meta estaba (y sigue) en revisión, y ese es el
sitio público que un revisor puede estar visitando. Tumbarlo a mitad de
revisión puede hacer que la rechacen, y volver a pedirla son semanas.

### Qué NO hacer mientras siga en revisión

**No cambiar el sitio declarado en Business Manager todavía.** Cambiar los datos
del negocio con una verificación en curso es la forma clásica de que Meta la
reinicie desde cero: no se gana tiempo, se pierde.

Si pasan varios días sin movimiento, se empuja **por soporte de Meta**, nunca
tocando los datos.

### Los cuatro pasos, en este orden

1. **Esperar** a que Meta apruebe. Sin esto, no empezar.

2. **Actualizar el sitio en Business Manager** a `https://nails.dalfistudio.com`
   (o la raíz `https://dalfistudio.com` — las dos sirven la misma página).
   Recién aprobada, este cambio ya no pone en riesgo nada.

3. **Borrar el último hostname viejo.** Es un custom domain de Worker, no un
   registro DNS suelto: al borrarlo se lleva su registro.

   ```sh
   # id al 2026-09-04: 166ab9c849dabac259458c777795bbc7805836c9
   # (confirmar antes, los ids cambian si se recrea el dominio)
   TOK=$(grep '^oauth_token' ~/.wrangler/config/default.toml | sed 's/.*= *"//; s/"$//')
   A=9a2f6a93ba1db97af9b88c781826a79c
   curl -s -H "Authorization: Bearer $TOK" \
     "https://api.cloudflare.com/client/v4/accounts/$A/workers/domains" |
     grep -o '[^"]*dalfistudionails.sebengroup.com[^"]*'
   # y luego DELETE .../workers/domains/<id>
   ```

   Si el token de wrangler da error de autenticación, refrescarlo corriendo
   `npx wrangler whoami` una vez.

4. **Quitar el origen de `render.yaml`.** En `SITE_CONTENT_ALLOWED_ORIGIN`,
   borrar `,https://dalfistudionails.sebengroup.com` del final. Commit y push:
   el servicio es *Blueprint managed* y sincroniza en el deploy.

   > **`render.yaml` MANDA sobre el dashboard de Render.** Cada despliegue
   > sobrescribe cualquier variable editada a mano en el panel. Para cambiar una
   > variable de entorno de este servicio se edita este archivo y se pushea.

### Comprobación después

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://dalfistudionails.sebengroup.com   # ya no debe servir
curl -s -o /dev/null -w "%{http_code}\n" https://nails.dalfistudio.com             # 200
curl -s -D- -o /dev/null -H 'Origin: https://nails.dalfistudio.com' \
  https://sebensuiteconnect.dalfistudio.com/api/site-content/dalfistudionails |
  grep -i access-control-allow-origin                                              # debe seguir
```

Con esto `sebengroup.com` queda solo con lo de SEBEN: `cash`,
`payadominotorneos`, `funceca`, `www` y todo el correo.

---

## 2. Adaptar la redacción al género, cuando se conozca

**Disparador:** que Roberto lo pida. No hay urgencia y hoy nada está roto.

### La regla

Nunca asumir el género del cliente en texto visible. La forma femenina solo se
usa si el sistema **de verdad** conoce el género de esa persona. El salón atiende
sobre todo mujeres, pero también hombres, y darles el femenino por defecto en un
correo es un error que el cliente ve.

Hoy **todo el producto es neutro**, que es el comportamiento correcto por
defecto. Está cubierto por la prueba `"ReservApp ya no dice 'clienta'…"` en
`tests/reservapp-admin-delete.test.js`, que es deliberadamente estricta —
rechaza la palabra incluso en comentarios nuevos. **Dejarla así**: si un cambio
la rompe, se reformula el texto, no se relaja la prueba.

### Lo que ya existe

El alta de cliente recoge el sexo y el backend lo guarda:

```html
<select id="new-sex">
  <option value="">No especificado</option>   <!-- valor por defecto -->
  <option value="Femenino">Femenino</option>
  <option value="Masculino">Masculino</option>
</select>
```

Pero **ningún texto lo usa**. El dato está guardado y sin aprovechar. Esto es
una funcionalidad por construir, no un fallo.

### Dónde tendría sentido aplicarlo

En los **correos y mensajes de WhatsApp de confirmación y recordatorio** — que
es donde dirigirse a alguien por su nombre y su género se nota de verdad. No en
la interfaz, donde el texto es genérico y no va dirigido a una persona concreta.

### La condición que no se puede saltar

**Siempre caer en neutro cuando el campo diga "No especificado"**, que es el
valor por defecto del formulario y probablemente el de la mayoría de las fichas
ya existentes. La rama con género es la excepción, no la norma: si se invierte,
el resultado es peor que dejarlo todo neutro como está hoy.
