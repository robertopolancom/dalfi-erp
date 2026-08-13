begin;

create or replace function app.json_num(item jsonb, field_name text, fallback numeric default 0)
returns numeric language sql immutable as $$
  select coalesce(nullif(item->>field_name,'')::numeric,fallback)
$$;

create or replace function migration.import_finance(p_run_id uuid)
returns jsonb language plpgsql as $$
declare doc jsonb; result jsonb;
begin
  select payload into doc from migration.source_snapshots
  where import_run_id=p_run_id order by created_at desc limit 1;
  if doc is null then raise exception 'Snapshot not found'; end if;
  if jsonb_typeof(doc->'data')='object' then doc:=doc->'data'; end if;

  insert into app.accounts(legacy_id,account_type,name,entity,product_type,account_number,
    holder,holder_document,currency,opening_balance,minimum_balance,status,legacy_payload,created_at,updated_at)
  select item->>'cuentaID',item->>'tipoCuenta',item->>'nombreCuenta',item->>'entidad',item->>'tipoProducto',
    item->>'numeroCuenta',item->>'titular',item->>'documentoTitular',coalesce(item->>'moneda','DOP'),
    app.json_num(item,'balanceInicial'),app.json_num(item,'balanceMinimo'),
    case when lower(coalesce(item->>'estado','Activo'))='activo' then 'active' else 'inactive' end,item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),
    coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'cuentas','[]')) item
  on conflict(legacy_id) do update set name=excluded.name,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.invoices(legacy_id,client_id,client_name_snapshot,issued_at,operation_date,status,
    subtotal,general_discount,general_surcharge,tip_charged,tip_pending,total,paid_confirmed,
    receivable_total,client_credit_balance,closing_legacy_id,inventory_consumption_status,notes,
    legacy_payload,created_at,updated_at)
  select item->>'facturaID',c.id,item->>'clienteNombre',
    coalesce(nullif(item->>'fechaHora','')::timestamptz,nullif(item->>'fechaCreacion','')::timestamptz,now()),
    coalesce(nullif(item->>'fechaOperacion','')::date,nullif(left(item->>'fechaHora',10),'')::date,current_date),
    coalesce(item->>'estadoFactura','Registrada'),app.json_num(item,'totalFacturado'),
    app.json_num(item,'descuentoGeneralMonto'),app.json_num(item,'adicionalGeneralMonto'),
    app.json_num(item,'propinaCobrada'),app.json_num(item,'propinaPendiente'),
    coalesce(nullif(item->>'totalConPropina','')::numeric,app.json_num(item,'totalFacturado')),
    app.json_num(item,'totalPagadoConfirmado'),app.json_num(item,'totalCxC'),app.json_num(item,'balanceFavorCliente'),
    item->>'cierreID',item->>'inventoryConsumptionStatus',item->>'observaciones',item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),
    coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'facturas','[]')) item
  left join app.clients c on c.legacy_id=item->>'clienteID'
  on conflict(legacy_id) do update set status=excluded.status,total=excluded.total,
    paid_confirmed=excluded.paid_confirmed,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.invoice_lines(legacy_id,invoice_id,service_id,staff_id,service_name_snapshot,
    staff_name_snapshot,quantity,base_price,extras,deductions,general_discount,
    subtotal_before_general_discount,subtotal,commissionable_amount,direct_cost_estimate,
    direct_margin_estimate,direct_margin_percent,station_legacy_id,legacy_payload,created_at,updated_at)
  select item->>'detalleID',i.id,s.id,st.id,coalesce(item->>'servicio','Servicio'),item->>'colaboradorNombre',
    app.json_num(item,'cantidad',1),app.json_num(item,'precioBase'),app.json_num(item,'extraMonto'),
    app.json_num(item,'deduccionMonto'),app.json_num(item,'deduccionGeneralMonto'),
    app.json_num(item,'subtotalAntesDescuentoGeneral'),app.json_num(item,'subtotal'),
    app.json_num(item,'montoComisionable'),app.json_num(item,'costoDirectoEstimado'),
    app.json_num(item,'margenDirectoEstimado'),nullif(item->>'margenDirectoPorcentaje','')::numeric,
    item->>'stationId',item,coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),
    coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'facturaDetalle','[]')) item
  join app.invoices i on i.legacy_id=item->>'facturaID'
  left join app.services s on s.legacy_id=item->>'servicioID'
  left join app.staff st on st.legacy_id=item->>'colaboradorID'
  on conflict(legacy_id) do update set subtotal=excluded.subtotal,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.payments(legacy_id,invoice_id,paid_at,method,gross_amount,confirmed_net_amount,
    retention_amount,destination_account_id,destination_account_name,card_processor_legacy_id,
    debtor_type,debtor_legacy_id,status,notes,legacy_payload,created_at,updated_at)
  select item->>'pagoID',i.id,coalesce(nullif(item->>'fechaHora','')::timestamptz,now()),
    coalesce(item->>'metodoPago','Sin especificar'),app.json_num(item,'montoBruto'),
    app.json_num(item,'montoNetoConfirmado'),app.json_num(item,'retencionTarjeta'),a.id,
    item->>'cuentaDestino',item->>'procesadorTarjetaID',item->>'deudorTipo',item->>'deudorID',
    item->>'estadoPago',item->>'observaciones',item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'pagosFactura','[]')) item
  left join app.invoices i on i.legacy_id=item->>'facturaID'
  left join app.accounts a on a.legacy_id=item->>'cuentaDestinoID'
  on conflict(legacy_id) do update set status=excluded.status,confirmed_net_amount=excluded.confirmed_net_amount,
    legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.income(legacy_id,invoice_id,client_id,received_at,cash_entry_at,income_type,method,
    gross_amount,net_amount,retention_amount,destination_account_id,status,notes,legacy_payload,created_at,updated_at)
  select item->>'ingresoID',i.id,c.id,coalesce(nullif(item->>'fechaHora','')::timestamptz,now()),
    nullif(item->>'fechaEntradaCaja','')::timestamptz,item->>'tipoIngreso',item->>'metodoPago',
    app.json_num(item,'montoBruto'),app.json_num(item,'montoNeto'),app.json_num(item,'retencion'),
    a.id,item->>'estado',item->>'observaciones',item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'ingresos','[]')) item
  left join app.invoices i on i.legacy_id=item->>'facturaID'
  left join app.clients c on c.legacy_id=item->>'clienteID'
  left join app.accounts a on a.legacy_id=item->>'cuentaDestinoID'
  on conflict(legacy_id) do update set net_amount=excluded.net_amount,status=excluded.status,
    legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.receivables(legacy_id,invoice_id,payment_id,debtor_type,debtor_legacy_id,debtor_name,
    receivable_type,source_type,source_legacy_id,originated_on,due_on,original_amount,applied_amount,
    outstanding_amount,status,concept,destination_account_id,legacy_payload,created_at,updated_at)
  select item->>'cxCID',i.id,p.id,item->>'deudorTipo',item->>'deudorID',item->>'deudorNombre',
    item->>'tipoCxC',item->>'sourceType',item->>'sourceId',coalesce(nullif(item->>'fechaOrigen','')::date,current_date),
    nullif(item->>'fechaVencimiento','')::date,app.json_num(item,'montoOriginal'),app.json_num(item,'montoAplicado'),
    app.json_num(item,'balancePendiente'),item->>'estado',item->>'concepto',a.id,item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'cuentasCobrar','[]')) item
  left join app.invoices i on i.legacy_id=item->>'facturaID'
  left join app.payments p on p.legacy_id=item->>'pagoID'
  left join app.accounts a on a.legacy_id=item->>'cuentaDestinoID'
  on conflict(legacy_id) do update set applied_amount=excluded.applied_amount,
    outstanding_amount=excluded.outstanding_amount,status=excluded.status,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.income_applications(legacy_id,income_id,receivable_id,invoice_id,payment_id,amount,
    notes,legacy_payload,created_at,updated_at)
  select item->>'aplicacionID',inc.id,r.id,i.id,p.id,app.json_num(item,'montoAplicado'),
    item->>'observaciones',item,coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),
    coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'ingresoAplicaciones','[]')) item
  join app.income inc on inc.legacy_id=item->>'ingresoID'
  join app.receivables r on r.legacy_id=item->>'cxCID'
  left join app.invoices i on i.legacy_id=item->>'facturaID'
  left join app.payments p on p.legacy_id=item->>'pagoID'
  on conflict(legacy_id) do update set amount=excluded.amount,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.tips(legacy_id,invoice_id,invoice_line_id,staff_id,occurred_at,method,gross_amount,
    card_retention,net_payable,payroll_payment_status,legacy_payload,created_at,updated_at)
  select item->>'propinaID',i.id,l.id,s.id,coalesce(nullif(item->>'fechaHora','')::timestamptz,now()),
    item->>'metodoPago',app.json_num(item,'montoBruto'),app.json_num(item,'retencion20Tarjeta'),
    app.json_num(item,'montoNetoPagar'),item->>'estadoPagoNomina',item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'propinas','[]')) item
  join app.invoices i on i.legacy_id=item->>'facturaID'
  left join app.invoice_lines l on l.legacy_id=item->>'detalleID'
  left join app.staff s on s.legacy_id=item->>'colaboradorID'
  on conflict(legacy_id) do update set net_payable=excluded.net_payable,
    payroll_payment_status=excluded.payroll_payment_status,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.cash_closings(legacy_id,business_date,closed_at,closing_type,register_closing_legacy_id,
    account_id,cashier,opening_balance,theoretical_balance,counted_balance,rectified_counted_balance,
    difference,initial_difference,shortage,initial_shortage,surplus,confirmed_income,expenses,
    credit_generated,card_expected,card_counted,transfer_expected,transfer_counted,status,provisional,
    requires_confirmation,details,notes,legacy_payload,created_at,updated_at)
  select item->>'cierreID',coalesce(nullif(item->>'businessDate','')::date,left(item->>'fechaHoraCierre',10)::date),
    coalesce(nullif(item->>'fechaHoraCierre','')::timestamptz,now()),item->>'closingType',item->>'registerClosingID',
    a.id,item->>'cajero',app.json_num(item,'balanceInicial'),app.json_num(item,'balanceTeorico'),
    app.json_num(item,'balanceContado'),app.json_num(item,'balanceContadoRectificado'),app.json_num(item,'diferencia'),
    app.json_num(item,'diferenciaInicial'),app.json_num(item,'cuadreFaltante'),app.json_num(item,'cuadreFaltanteInicial'),
    app.json_num(item,'sobranteCaja'),app.json_num(item,'ingresosConfirmados'),app.json_num(item,'egresos'),
    app.json_num(item,'creditoGenerado'),app.json_num(item,'tarjetaEsperada'),app.json_num(item,'tarjetaContada'),
    app.json_num(item,'transferenciaEsperada'),app.json_num(item,'transferenciaContada'),item->>'estado',
    coalesce((item->>'provisional')::boolean,false),coalesce((item->>'requiereConfirmacion')::boolean,false),
    jsonb_build_object('cuentas',coalesce(item->'cuentas','[]'),'totales',coalesce(item->'totales','{}'),
      'detalleColaboradores',coalesce(item->'detalleColaboradores','[]')),item->>'observaciones',item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'cierres','[]')) item
  left join app.accounts a on a.legacy_id=item->>'cuentaID'
  on conflict(legacy_id) do update set status=excluded.status,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  insert into app.warehouses(legacy_id,name,warehouse_type,active,tracks_stock,allows_consumption,
    allows_custody,allows_transfer,allows_sale,minimum_stock,target_stock,notes,legacy_payload,created_at,updated_at)
  select item->>'locationId',item->>'nombre',item->>'tipo',coalesce((item->>'activa')::boolean,true),
    coalesce((item->>'controlaExistencia')::boolean,true),coalesce((item->>'permiteConsumo')::boolean,false),
    coalesce((item->>'permiteCustodia')::boolean,false),coalesce((item->>'permiteTransferencia')::boolean,true),
    coalesce((item->>'permiteVenta')::boolean,false),nullif(item->>'stockMinimo','')::numeric,
    nullif(item->>'stockObjetivo','')::numeric,item->>'observaciones',item,
    coalesce(nullif(item->>'fechaCreacion','')::timestamptz,now()),coalesce(nullif(item->>'fechaActualizacion','')::timestamptz,now())
  from jsonb_array_elements(coalesce(doc->'almacenes','[]')) item
  on conflict(legacy_id) do update set name=excluded.name,legacy_payload=excluded.legacy_payload,updated_at=excluded.updated_at;

  result:=jsonb_build_object(
    'accounts',(select count(*) from app.accounts),'invoices',(select count(*) from app.invoices),
    'invoiceLines',(select count(*) from app.invoice_lines),'payments',(select count(*) from app.payments),
    'income',(select count(*) from app.income),'receivables',(select count(*) from app.receivables),
    'incomeApplications',(select count(*) from app.income_applications),'tips',(select count(*) from app.tips),
    'cashClosings',(select count(*) from app.cash_closings),'warehouses',(select count(*) from app.warehouses));
  update migration.import_runs set imported_counts=imported_counts||result where id=p_run_id;
  return result;
end $$;

commit;
