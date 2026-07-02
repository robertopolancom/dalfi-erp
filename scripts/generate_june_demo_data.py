import json
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "outputs" / "database.json"

with DB_PATH.open("r", encoding="utf-8") as f:
    db = json.load(f)

data = db.setdefault("data", {})

for key in [
    "clientes",
    "colaboradores",
    "servicios",
    "cuentas",
    "procesadores",
    "suplidores",
    "umbralesComision",
    "facturas",
    "facturaDetalle",
    "pagosFactura",
    "cuentasCobrar",
    "ingresos",
    "ingresoAplicaciones",
    "egresos",
    "transferencias",
    "cierres",
    "propinas",
    "nomina",
    "cuentasPagar",
    "reservas",
]:
    data.setdefault(key, [])

def keep_non_test(row):
    return not any(str(value).startswith("TEST-") or str(value).startswith("JUN-TEST") for value in row.values())

for key in [
    "clientes",
    "colaboradores",
    "servicios",
    "cuentas",
    "procesadores",
    "suplidores",
    "umbralesComision",
    "facturas",
    "facturaDetalle",
    "pagosFactura",
    "cuentasCobrar",
    "ingresos",
    "ingresoAplicaciones",
    "egresos",
    "transferencias",
    "cierres",
    "propinas",
    "nomina",
    "cuentasPagar",
    "reservas",
]:
    data[key] = [row for row in data[key] if keep_non_test(row)]

data["umbralesComision"] = [
    row for row in data["umbralesComision"]
    if str(row.get("aplicaA", "")).strip().lower() != "global"
]

clients = [
    ("TEST-CLI-001", "Amelia Rosario"),
    ("TEST-CLI-002", "Bianca Medina"),
    ("TEST-CLI-003", "Camila Soto"),
    ("TEST-CLI-004", "Daniela Cruz"),
    ("TEST-CLI-005", "Elena Vargas"),
    ("TEST-CLI-006", "Fabiola Peña"),
    ("TEST-CLI-007", "Gabriela Núñez"),
    ("TEST-CLI-008", "Helena Rojas"),
    ("TEST-CLI-009", "Isabel Mota"),
    ("TEST-CLI-010", "Juliana Díaz"),
    ("TEST-CLI-011", "Karina León"),
    ("TEST-CLI-012", "Laura Mejía"),
    ("TEST-CLI-013", "Mariela Pimentel"),
    ("TEST-CLI-014", "Natalia Gómez"),
    ("TEST-CLI-015", "Olga Batista"),
    ("TEST-CLI-016", "Patricia Santos"),
    ("TEST-CLI-017", "Raquel Jiménez"),
    ("TEST-CLI-018", "Sabrina Torres"),
    ("TEST-CLI-019", "Tamara Castillo"),
    ("TEST-CLI-020", "Valeria Acosta"),
]
for i, (cid, name) in enumerate(clients, 1):
    first, *last = name.split()
    data["clientes"].append({
        "clienteID": cid,
        "nombreCompleto": name,
        "nombre": first,
        "apellido": " ".join(last),
        "telefono": f"809-777-{1000+i:04d}",
        "sexo": "Femenino",
        "correo": f"cliente{i:02d}@demo.local",
        "direccion": f"Dirección prueba {i}",
        "estado": "Activo",
        "fechaRegistro": "2026-06-01",
        "observaciones": "JUN-TEST cliente para simulación mensual",
    })

thresholds = []
staff = [
    ("TEST-COL-001", "Rosa Jiménez", 22000, "Manicurista Senior"),
    ("TEST-COL-002", "Paola Reyes", 18000, "Manicurista"),
    ("TEST-COL-003", "Karla Núñez", 16000, "Manicurista"),
    ("TEST-COL-004", "Lia Fernández", 15000, "Pedicurista"),
]
for sidx, (sid, name, salary, role) in enumerate(staff, 1):
    ids = []
    ranges = [(0, 73000, 0), (73000.01, 160000, 0.20), (160000.01, 9999999, 0.30)]
    for ridx, (start, end, rate) in enumerate(ranges, 1):
        tid = f"TEST-UMB-{sidx:02d}-{ridx}"
        ids.append(tid)
        thresholds.append({
            "escalaID": tid,
            "aplicaA": f"{name} Rango {ridx}",
            "desde": start,
            "hasta": end,
            "porcentajeComision": rate,
            "estado": "Activo",
        })
    first, *last = name.split()
    data["colaboradores"].append({
        "colaboradorID": sid,
        "nombreCompleto": name,
        "nombre": first,
        "apellido": " ".join(last),
        "funcion": role,
        "telefono": f"829-555-{sidx:04d}",
        "salarioMensual": salary,
        "direccion": f"Residencial prueba {sidx}",
        "correo": f"{first.lower()}@demo.local",
        "estado": "Activo",
        "fechaIngreso": "2026-05-15",
        "umbralesComisionActivos": ids,
        "observaciones": "JUN-TEST colaborador con umbrales asignados",
    })
data["umbralesComision"].extend(thresholds)

services = [
    ("TEST-SER-001", "Manicure gel prueba", 1200, 60),
    ("TEST-SER-002", "Pedicure spa prueba", 1600, 75),
    ("TEST-SER-003", "Acrílico completo prueba", 2300, 120),
    ("TEST-SER-004", "Relleno acrílico prueba", 1400, 90),
    ("TEST-SER-005", "Diseño premium prueba", 650, 30),
    ("TEST-SER-006", "Retiro de gel prueba", 500, 30),
    ("TEST-SER-007", "Pedicura clínica prueba", 3000, 90),
    ("TEST-SER-008", "Manicure regular prueba", 850, 45),
]
for sid, name, price, duration in services:
    data["servicios"].append({
        "servicioID": sid,
        "servicio": name,
        "categoria": "Uñas",
        "precioBase": price,
        "duracionMin": duration,
        "estado": "Activo",
    })

accounts = [
    ("TEST-CTA-001", "Caja Operativa", "Caja Registradora", "Caja", "Efectivo", 35000),
    ("TEST-CTA-002", "Caja Fuerte", "Caja Fuerte", "Caja", "Efectivo", 150000),
    ("TEST-CTA-003", "Caja Chica", "Caja Chica", "Caja", "Efectivo", 15000),
    ("TEST-CTA-004", "Banco", "Banco Popular Prueba", "Banco Popular", "Cuenta Corriente", 250000),
    ("TEST-CTA-005", "Banco", "Banco BHD Prueba", "Banco BHD", "Cuenta Corriente", 175000),
]
for aid, acc_type, name, entity, product, opening in accounts:
    data["cuentas"].append({
        "cuentaID": aid,
        "tipoCuenta": acc_type,
        "nombreCuenta": name,
        "entidad": entity,
        "tipoProducto": product,
        "numeroCuenta": aid.replace("TEST-CTA-", "000-"),
        "titular": "Dalfi Studio Nail",
        "documentoTitular": "JUN-TEST",
        "moneda": "DOP",
        "balanceInicial": opening,
        "balanceMinimo": 0,
        "estado": "Activo",
    })

processors = [
    ("TEST-PRO-001", "Azul Prueba", 0.028),
    ("TEST-PRO-002", "CardNet Prueba", 0.031),
    ("TEST-PRO-003", "VisaNet Prueba", 0.0275),
]
processor_rates = {name: rate for _, name, rate in processors}
for pid, name, rate in processors:
    data["procesadores"].append({"procesadorID": pid, "nombre": name, "tipo": "Tarjeta", "comisionPorcentaje": rate, "estado": "Activo"})

suppliers = [("TEST-SUP-001", "Suplidor Productos Prueba"), ("TEST-SUP-002", "Suplidor Servicios Prueba")]
for sid, name in suppliers:
    data["suplidores"].append({"suplidorID": sid, "nombre": name, "tipo": "Servicios/Productos", "estado": "Activo"})

payment_methods = [
    "efectivo",
    "tarjeta",
    "transferencia_confirmada",
    "credito",
    "transferencia_pendiente",
    "mixto",
]

invoice_counter = detail_counter = payment_counter = income_counter = app_counter = cxc_counter = tip_counter = 1
daily = {}

def add_income(day, invoice_id, client_id, client_name, method, amount, account_id, account_name, note, processor_name=""):
    global income_counter
    ingreso_id = f"TEST-ING-{income_counter:04d}"
    income_counter += 1
    retention = round(amount * processor_rates.get(processor_name, 0), 2) if method == "tarjeta" else 0
    net = round(amount - retention, 2)
    data["ingresos"].append({
        "ingresoID": ingreso_id,
        "fechaHora": f"{day}T16:00:00",
        "tipoIngreso": note,
        "facturaID": invoice_id,
        "clienteID": client_id,
        "clienteNombre": client_name,
        "metodoPago": method,
        "cuentaDestinoID": account_id,
        "cuentaDestino": account_name,
        "montoBruto": amount,
        "retencion": retention,
        "montoNeto": net,
        "estado": "Confirmado",
        "observaciones": "JUN-TEST ingreso",
    })
    return ingreso_id, net

for day_num in range(1, 30):
    day = date(2026, 6, day_num).isoformat()
    daily[day] = {"cash": 0, "card": 0, "transfer": 0, "credit": 0, "expenses": 0}
    for slot in range(4):
        client_id, client_name = clients[(day_num + slot) % len(clients)]
        staff_id, staff_name, *_ = staff[(day_num + slot) % len(staff)]
        service_id, service_name, price, _ = services[(day_num + slot) % len(services)]
        invoice_id = f"TEST-FAC-{invoice_counter:04d}"
        detail_id = f"TEST-DET-{detail_counter:04d}"
        invoice_counter += 1
        detail_counter += 1
        extra = 250 if slot == 1 else 0
        discount = 150 if slot == 2 else 0
        subtotal = price + extra - discount
        tip = 200 + (50 * (slot % 3))
        method = payment_methods[(day_num + slot) % len(payment_methods)]
        total = subtotal + tip
        paid_confirmed = 0
        cxc_amount = 0
        status = "Pagada"
        data["facturaDetalle"].append({
            "detalleID": detail_id,
            "facturaID": invoice_id,
            "servicioID": service_id,
            "servicio": service_name,
            "colaboradorID": staff_id,
            "colaboradorNombre": staff_name,
            "cantidad": 1,
            "precioBase": price,
            "extraMonto": extra,
            "extraConcepto_50": "JUN-TEST adicional" if extra else "",
            "deduccionMonto": discount,
            "deduccionConcepto_50": "JUN-TEST descuento" if discount else "",
            "subtotal": subtotal,
        })
        cash_part = card_part = transfer_part = credit_part = pending_part = 0
        if method == "efectivo":
            cash_part = total
        elif method == "tarjeta":
            card_part = total
        elif method == "transferencia_confirmada":
            transfer_part = total
        elif method == "credito":
            credit_part = total
        elif method == "transferencia_pendiente":
            pending_part = total
        else:
            cash_part = round(total * 0.45, 2)
            card_part = round(total * 0.35, 2)
            credit_part = round(total - cash_part - card_part, 2)

        for method_name, amount, account_id, account_name in [
            ("efectivo", cash_part, "TEST-CTA-001", "Caja Registradora"),
            ("tarjeta", card_part, "TEST-CTA-004", "Banco Popular Prueba"),
            ("transferencia_confirmada", transfer_part, "TEST-CTA-005", "Banco BHD Prueba"),
        ]:
            if amount <= 0:
                continue
            pago_id = f"TEST-PAG-{payment_counter:04d}"
            payment_counter += 1
            processor_id = processors[(day_num + slot) % len(processors)][0] if method_name == "tarjeta" else ""
            processor_name = processors[(day_num + slot) % len(processors)][1] if method_name == "tarjeta" else ""
            retention = round(amount * processor_rates.get(processor_name, 0), 2) if method_name == "tarjeta" else 0
            net = round(amount - retention, 2)
            data["pagosFactura"].append({
                "pagoID": pago_id,
                "facturaID": invoice_id,
                "fechaHora": f"{day}T15:{slot}0:00",
                "metodoPago": method_name,
                "estadoPago": "Confirmado",
                "cuentaDestinoID": account_id,
                "cuentaDestino": account_name,
                "procesadorTarjetaID": processor_id,
                "montoBruto": amount,
                "retencionTarjeta": retention,
                "montoNetoConfirmado": net,
                "deudorTipo": "Cliente",
                "deudorID": client_id,
                "observaciones": "JUN-TEST pago confirmado",
            })
            ingreso_id, income_net = add_income(day, invoice_id, client_id, client_name, method_name, amount, account_id, account_name, "Cobro factura prueba", processor_name)
            data["ingresoAplicaciones"].append({
                "aplicacionID": f"TEST-APL-{app_counter:04d}",
                "ingresoID": ingreso_id,
                "facturaID": invoice_id,
                "pagoID": pago_id,
                "cxCID": "",
                "montoAplicado": amount,
                "observaciones": "JUN-TEST aplicado a factura",
            })
            app_counter += 1
            paid_confirmed += amount
            if method_name == "efectivo":
                daily[day]["cash"] += amount
            elif method_name == "tarjeta":
                daily[day]["card"] += amount
                cxc_id = f"TEST-CXC-{cxc_counter:04d}"
                cxc_counter += 1
                proc_id, proc_name = processors[(day_num + slot) % len(processors)]
                data["cuentasCobrar"].append({
                    "cxCID": cxc_id,
                    "fechaOrigen": f"{day}T15:00:00",
                    "tipoCxC": "CxC procesador tarjeta",
                    "deudorTipo": "Procesador",
                    "deudorID": proc_id,
                    "deudorNombre": proc_name,
                    "facturaID": invoice_id,
                    "pagoID": pago_id,
                    "montoOriginal": amount,
                    "montoAplicado": 0,
                    "balancePendiente": amount,
                    "estado": "Pendiente conciliación",
                    "concepto": "JUN-TEST tarjeta pendiente de conciliación",
                    "fechaVencimiento": day,
                })
            else:
                daily[day]["transfer"] += amount

        for concept, amount in [("Crédito cliente", credit_part), ("Transferencia pendiente por confirmar", pending_part)]:
            if amount <= 0:
                continue
            cxc_id = f"TEST-CXC-{cxc_counter:04d}"
            cxc_counter += 1
            applied = 0
            balance = amount
            state = "Pendiente"
            due = (date.fromisoformat(day) + timedelta(days=7)).isoformat() if "Crédito" in concept else day
            if "Transferencia" in concept and day_num % 5 == 0:
                state = "Declinada - CxC cliente"
                concept = "Transferencia declinada - cuenta por cobrar vencida"
                due = day
            elif "Crédito" in concept and day_num % 4 == 0:
                applied = round(amount * 0.5, 2)
                balance = round(amount - applied, 2)
                state = "Parcial"
                ingreso_id, _ = add_income(day, invoice_id, client_id, client_name, "transferencia_confirmada", applied, "TEST-CTA-005", "Banco BHD Prueba", "Cobro parcial crédito prueba")
                data["ingresoAplicaciones"].append({
                    "aplicacionID": f"TEST-APL-{app_counter:04d}",
                    "ingresoID": ingreso_id,
                    "facturaID": invoice_id,
                    "pagoID": "",
                    "cxCID": cxc_id,
                    "montoAplicado": applied,
                    "observaciones": "JUN-TEST abono CxC",
                })
                app_counter += 1
                paid_confirmed += applied
                daily[day]["transfer"] += applied
            data["cuentasCobrar"].append({
                "cxCID": cxc_id,
                "fechaOrigen": f"{day}T15:00:00",
                "tipoCxC": concept,
                "deudorTipo": "Cliente",
                "deudorID": client_id,
                "deudorNombre": client_name,
                "facturaID": invoice_id,
                "pagoID": "",
                "montoOriginal": amount,
                "montoAplicado": applied,
                "balancePendiente": balance,
                "estado": state,
                "concepto": concept,
                "fechaVencimiento": due,
            })
            cxc_amount += balance
            daily[day]["credit"] += balance

        data["propinas"].append({
            "propinaID": f"TEST-PROPI-{tip_counter:04d}",
            "fechaHora": f"{day}T16:30:00",
            "facturaID": invoice_id,
            "detalleID": detail_id,
            "colaboradorID": staff_id,
            "colaboradorNombre": staff_name,
            "montoBruto": tip,
            "metodoPago": "tarjeta" if card_part else "contado",
            "retencion20Tarjeta": round(tip * 0.05, 2) if card_part else 0,
            "montoNetoPagar": round(tip * 0.95, 2) if card_part else tip,
            "estadoPagoNomina": "Pendiente",
        })
        tip_counter += 1

        status = "Parcial" if cxc_amount > 0 else "Pagada"
        data["facturas"].append({
            "facturaID": invoice_id,
            "fechaHora": f"{day}T14:{slot}5:00",
            "clienteID": client_id,
            "clienteNombre": client_name,
            "colaboradorID": staff_id,
            "colaboradorNombre": staff_name,
            "estadoFactura": status,
            "totalFacturado": total,
            "totalPagadoConfirmado": round(paid_confirmed, 2),
            "totalCxC": round(cxc_amount, 2),
            "balanceFavorCliente": 0,
            "cierreID": f"TEST-CIE-{day_num:02d}",
            "observaciones": f"JUN-TEST escenario {method}",
        })

    if day_num in [3, 10, 17, 24]:
        egreso_id = f"TEST-EGR-{day_num:04d}"
        amount = 2500 + day_num * 20
        data["egresos"].append({
            "egresoID": egreso_id,
            "fechaHora": f"{day}T11:00:00",
            "tipoEgreso": "gasto",
            "tipo": "gasto",
            "categoria": "Operativo",
            "concepto": "Compra productos prueba",
            "cuentaOrigenID": "TEST-CTA-001",
            "cuentaOrigen": "Caja Registradora",
            "cuentaDestinoID": "",
            "cuentaDestino": "",
            "metodoSalida": "efectivo",
            "monto": amount,
            "beneficiario": "Suplidor Productos Prueba",
            "estado": "Registrado",
            "observaciones": "JUN-TEST egreso operativo",
        })
        daily[day]["expenses"] += amount
    if day_num in [7, 14, 21, 28]:
        amount = 9000
        data["transferencias"].append({
            "transferenciaID": f"TEST-TRF-{day_num:04d}",
            "fechaHora": f"{day}T18:00:00",
            "cuentaOrigenID": "TEST-CTA-001",
            "cuentaOrigen": "Caja Registradora",
            "cuentaDestinoID": "TEST-CTA-002",
            "cuentaDestino": "Caja Fuerte",
            "monto": amount,
            "metodo": "Retiro efectivo",
            "estado": "Confirmada",
            "cierreID": f"TEST-CIE-{day_num:02d}",
            "observaciones": "JUN-TEST retiro semanal a caja fuerte",
        })
    if day_num in [12, 22]:
        staff_id, staff_name, *_ = staff[day_num % len(staff)]
        amount = 3000
        data["egresos"].append({
            "egresoID": f"TEST-EGR-AV-{day_num:02d}",
            "fechaHora": f"{day}T10:30:00",
            "tipoEgreso": "avance",
            "tipo": "avance",
            "categoria": "Avance colaborador",
            "concepto": "Avance efectivo prueba",
            "cuentaOrigenID": "TEST-CTA-001",
            "cuentaOrigen": "Caja Registradora",
            "monto": amount,
            "beneficiario": staff_name,
            "estado": "Registrado",
            "observaciones": "JUN-TEST avance descontable payroll",
        })
        cxc_id = f"TEST-CXC-{cxc_counter:04d}"
        cxc_counter += 1
        data["cuentasCobrar"].append({
            "cxCID": cxc_id,
            "fechaOrigen": f"{day}T10:30:00",
            "tipoCxC": "Avance colaborador",
            "deudorTipo": "Colaborador",
            "deudorID": staff_id,
            "deudorNombre": staff_name,
            "facturaID": "",
            "pagoID": "",
            "montoOriginal": amount,
            "montoAplicado": 0,
            "balancePendiente": amount,
            "estado": "Pendiente",
            "concepto": "JUN-TEST avance colaborador",
            "fechaVencimiento": day,
        })
        daily[day]["expenses"] += amount

    counted = daily[day]["cash"] - daily[day]["expenses"]
    shortage = 200 if day_num == 13 else 0
    surplus = 150 if day_num == 19 else 0
    counted_final = counted - shortage + surplus
    data["cierres"].append({
        "cierreID": f"TEST-CIE-{day_num:02d}",
        "fechaHoraCierre": f"{day}T23:59:00",
        "cajero": "Rosa Jiménez",
        "cuentaCaja": "Caja Registradora",
        "cuentaID": "TEST-CTA-001",
        "balanceInicial": 0,
        "ingresosConfirmados": round(daily[day]["cash"], 2),
        "egresos": round(daily[day]["expenses"], 2),
        "balanceTeorico": round(daily[day]["cash"], 2),
        "balanceContado": round(counted_final, 2),
        "conteoInicial": round(counted - shortage, 2),
        "balanceContadoRectificado": round(counted_final, 2) if shortage else 0,
        "diferenciaInicial": -shortage,
        "diferencia": surplus,
        "cuadreFaltante": 0,
        "cuadreFaltanteInicial": shortage,
        "sobranteCaja": surplus,
        "estado": "Cerrado",
        "loteTarjeta": f"LOTE-JUN-{day_num:02d}",
        "tarjetaContada": round(daily[day]["card"], 2),
        "tarjetaEsperada": round(daily[day]["card"], 2),
        "procesadorTarjeta": "Azul/CardNet/VisaNet",
        "transferenciaContada": round(daily[day]["transfer"], 2),
        "transferenciaEsperada": round(daily[day]["transfer"], 2),
        "creditoGenerado": round(daily[day]["credit"], 2),
        "motivoFaltante": "JUN-TEST cuadre inicial faltante rectificado" if shortage else "",
        "observaciones": "JUN-TEST cierre diario con tarjetas/transferencias/crédito",
    })

payroll_counter = 1
cxp_counter = 1
for staff_id, staff_name, salary, _ in staff:
    details = [d for d in data["facturaDetalle"] if d.get("colaboradorID") == staff_id and str(d.get("detalleID", "")).startswith("TEST-")]
    sales = sum(float(d.get("subtotal", 0) or 0) for d in details)
    collaborator = next(c for c in data["colaboradores"] if c["colaboradorID"] == staff_id)
    assigned = collaborator["umbralesComisionActivos"]
    matching = [t for t in data["umbralesComision"] if t["escalaID"] in assigned and sales >= float(t["desde"]) and (float(t["hasta"]) <= 0 or sales <= float(t["hasta"]))]
    threshold = sorted(matching, key=lambda x: float(x["desde"]), reverse=True)[0] if matching else None
    rate = float(threshold["porcentajeComision"]) if threshold else 0
    commission = round(sales * rate, 2)
    tips = round(sum(float(p.get("montoNetoPagar", 0) or 0) for p in data["propinas"] if p["colaboradorID"] == staff_id), 2)
    advance_cxcs = [c for c in data["cuentasCobrar"] if c.get("deudorTipo") == "Colaborador" and c.get("deudorID") == staff_id and float(c.get("balancePendiente", 0) or 0) > 0]
    cxc_discount = round(sum(float(c["balancePendiente"]) for c in advance_cxcs), 2)
    for c in advance_cxcs:
        c["montoAplicado"] = c["montoOriginal"]
        c["balancePendiente"] = 0
        c["estado"] = "Saldada por payroll"
    afp = round(salary * 0.0287, 2)
    insurance = round(salary * 0.0304, 2)
    other = 500 if staff_id.endswith("004") else 0
    deductions = round(afp + insurance + other + cxc_discount, 2)
    net = round(salary + commission + tips - deductions, 2)
    nom_id = f"TEST-NOM-{payroll_counter:04d}"
    payroll_counter += 1
    data["nomina"].append({
        "nominaID": nom_id,
        "periodoInicio": "2026-06-01",
        "periodoFin": "2026-06-29",
        "quincena": "Mes completo prueba junio",
        "colaboradorID": staff_id,
        "colaboradorNombre": staff_name,
        "salarioBaseMensual": salary,
        "salarioQuincenal": salary / 2,
        "totalFacturadoMes": round(sales, 2),
        "porcentajeComision": rate,
        "comisionGenerada": commission,
        "propinaNetaMes": tips,
        "anticipos": deductions,
        "descuentoAFP": afp,
        "descuentoSeguro": insurance,
        "descuentoOtros": other,
        "descuentoCxC": cxc_discount,
        "conceptoOtrosDescuentos": "JUN-TEST ajuste uniforme" if other else "",
        "totalAPagar": net,
        "estado": "Pendiente",
    })
    data["cuentasPagar"].append({
        "cxPID": f"TEST-CXP-{cxp_counter:04d}",
        "fechaOrigen": "2026-06-29T18:00:00",
        "tipoCxP": "Nómina",
        "acreedorTipo": "Colaborador",
        "acreedorID": staff_id,
        "acreedorNombre": staff_name,
        "nominaID": nom_id,
        "montoOriginal": net,
        "montoPagado": 0,
        "balancePendiente": net,
        "estado": "Pendiente",
        "concepto": "JUN-TEST payroll junio",
        "fechaVencimiento": "2026-06-29",
    })
    cxp_counter += 1
    for p in data["propinas"]:
        if p.get("colaboradorID") == staff_id and str(p.get("propinaID", "")).startswith("TEST-"):
            p["estadoPagoNomina"] = "Pagada"
            p["nominaID"] = nom_id

db["meta"]["version"] = 2
db["meta"]["storageKey"] = "dalfi-erp-db-v2-june-test"
db["meta"]["demoScenario"] = "JUN-TEST operaciones junio 2026"
db["meta"]["updatedAt"] = datetime.now().isoformat(timespec="seconds")

with DB_PATH.open("w", encoding="utf-8") as f:
    json.dump(db, f, ensure_ascii=False, indent=2)
    f.write("\n")

summary = {
    "clientes_prueba": len(clients),
    "colaboradores_prueba": len(staff),
    "servicios_prueba": len(services),
    "facturas_prueba": len([f for f in data["facturas"] if f["facturaID"].startswith("TEST-")]),
    "cierres_prueba": len([c for c in data["cierres"] if c["cierreID"].startswith("TEST-")]),
    "nominas_prueba": len([n for n in data["nomina"] if n["nominaID"].startswith("TEST-")]),
    "cuentas_cobrar_prueba": len([c for c in data["cuentasCobrar"] if c["cxCID"].startswith("TEST-")]),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
