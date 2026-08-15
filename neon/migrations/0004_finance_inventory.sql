begin;

create table if not exists app.accounts (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  account_type text, name text not null, entity text, product_type text,
  account_number text, holder text, holder_document text, currency text not null default 'DOP',
  opening_balance numeric(16,2) not null default 0, minimum_balance numeric(16,2) not null default 0,
  status text not null default 'active', legacy_payload jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists app.invoices (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  client_id uuid references app.clients(id), client_name_snapshot text,
  issued_at timestamptz not null, operation_date date,
  status text not null, subtotal numeric(16,2) not null default 0,
  general_discount numeric(16,2) not null default 0,
  general_surcharge numeric(16,2) not null default 0,
  tip_charged numeric(16,2) not null default 0, tip_pending numeric(16,2) not null default 0,
  total numeric(16,2) not null default 0, paid_confirmed numeric(16,2) not null default 0,
  receivable_total numeric(16,2) not null default 0, client_credit_balance numeric(16,2) not null default 0,
  closing_legacy_id text, inventory_consumption_status text, notes text,
  legacy_payload jsonb not null default '{}', created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invoices_client_date_idx on app.invoices(client_id,issued_at desc);

create table if not exists app.invoice_lines (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  invoice_id uuid not null references app.invoices(id) on delete cascade,
  service_id uuid references app.services(id), staff_id uuid references app.staff(id),
  service_name_snapshot text not null, staff_name_snapshot text,
  quantity numeric(12,3) not null default 1, base_price numeric(16,2) not null default 0,
  extras numeric(16,2) not null default 0, deductions numeric(16,2) not null default 0,
  general_discount numeric(16,2) not null default 0,
  subtotal_before_general_discount numeric(16,2) not null default 0,
  subtotal numeric(16,2) not null default 0, commissionable_amount numeric(16,2) not null default 0,
  direct_cost_estimate numeric(16,2) not null default 0, direct_margin_estimate numeric(16,2) not null default 0,
  direct_margin_percent numeric(10,6), station_legacy_id text,
  legacy_payload jsonb not null default '{}', created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invoice_lines_invoice_idx on app.invoice_lines(invoice_id);

create table if not exists app.payments (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  invoice_id uuid references app.invoices(id), paid_at timestamptz not null,
  method text not null, gross_amount numeric(16,2) not null default 0,
  confirmed_net_amount numeric(16,2) not null default 0, retention_amount numeric(16,2) not null default 0,
  destination_account_id uuid references app.accounts(id), destination_account_name text,
  card_processor_legacy_id text, debtor_type text, debtor_legacy_id text,
  status text, notes text, legacy_payload jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists app.income (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  invoice_id uuid references app.invoices(id), client_id uuid references app.clients(id),
  received_at timestamptz not null, cash_entry_at timestamptz,
  income_type text, method text, gross_amount numeric(16,2) not null default 0,
  net_amount numeric(16,2) not null default 0, retention_amount numeric(16,2) not null default 0,
  destination_account_id uuid references app.accounts(id), status text, notes text,
  legacy_payload jsonb not null default '{}', created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.receivables (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  invoice_id uuid references app.invoices(id), payment_id uuid references app.payments(id),
  debtor_type text, debtor_legacy_id text, debtor_name text, receivable_type text,
  source_type text, source_legacy_id text, originated_on date not null, due_on date,
  original_amount numeric(16,2) not null default 0, applied_amount numeric(16,2) not null default 0,
  outstanding_amount numeric(16,2) not null default 0, status text, concept text,
  destination_account_id uuid references app.accounts(id), legacy_payload jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists app.income_applications (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  income_id uuid not null references app.income(id), receivable_id uuid not null references app.receivables(id),
  invoice_id uuid references app.invoices(id), payment_id uuid references app.payments(id),
  amount numeric(16,2) not null check(amount >= 0), notes text,
  legacy_payload jsonb not null default '{}', created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.tips (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  invoice_id uuid not null references app.invoices(id), invoice_line_id uuid references app.invoice_lines(id),
  staff_id uuid references app.staff(id), occurred_at timestamptz not null, method text,
  gross_amount numeric(16,2) not null default 0, card_retention numeric(16,2) not null default 0,
  net_payable numeric(16,2) not null default 0, payroll_payment_status text,
  legacy_payload jsonb not null default '{}', created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.cash_closings (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  business_date date not null, closed_at timestamptz not null, closing_type text,
  register_closing_legacy_id text, account_id uuid references app.accounts(id), cashier text,
  opening_balance numeric(16,2) not null default 0, theoretical_balance numeric(16,2) not null default 0,
  counted_balance numeric(16,2) not null default 0, rectified_counted_balance numeric(16,2) not null default 0,
  difference numeric(16,2) not null default 0, initial_difference numeric(16,2) not null default 0,
  shortage numeric(16,2) not null default 0, initial_shortage numeric(16,2) not null default 0,
  surplus numeric(16,2) not null default 0, confirmed_income numeric(16,2) not null default 0,
  expenses numeric(16,2) not null default 0, credit_generated numeric(16,2) not null default 0,
  card_expected numeric(16,2) not null default 0, card_counted numeric(16,2) not null default 0,
  transfer_expected numeric(16,2) not null default 0, transfer_counted numeric(16,2) not null default 0,
  status text, provisional boolean not null default false, requires_confirmation boolean not null default false,
  details jsonb not null default '{}', notes text, legacy_payload jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists cash_closings_date_idx on app.cash_closings(business_date desc);

create table if not exists app.warehouses (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  name text not null, warehouse_type text, active boolean not null default true,
  tracks_stock boolean not null default true, allows_consumption boolean not null default false,
  allows_custody boolean not null default false, allows_transfer boolean not null default true,
  allows_sale boolean not null default false, minimum_stock numeric(16,3), target_stock numeric(16,3),
  notes text, legacy_payload jsonb not null default '{}', created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.inventory_items (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  sku text, name text not null, category text, item_type text, unit text,
  cost numeric(16,4) not null default 0, average_cost numeric(16,4) not null default 0,
  sale_price numeric(16,2) not null default 0, minimum_stock numeric(16,3) not null default 0,
  status text not null default 'active', notes text, legacy_payload jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists inventory_items_sku_unique on app.inventory_items(lower(sku)) where sku is not null and btrim(sku)<>'';

create table if not exists app.inventory_movements (
  id uuid primary key default gen_random_uuid(), legacy_id text unique not null,
  item_id uuid not null references app.inventory_items(id), warehouse_id uuid references app.warehouses(id),
  occurred_at timestamptz not null, movement_type text not null, quantity numeric(16,3) not null,
  unit_cost numeric(16,4) not null default 0, source_key text unique, reference text, reason text,
  notes text, legacy_payload jsonb not null default '{}', created_at timestamptz not null default now()
);

commit;
