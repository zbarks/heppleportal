-- ============================================================
--  HEPPLE PORTAL — Shopify customers reference table
--  Run once in Supabase → SQL Editor. Safe to re-run.
--
--  Holds Shopify's customer-level data (verified lifetime spend,
--  total orders, marketing consent, tags, address). Keyed by
--  email so it lines up with the orders table.
-- ============================================================

create table if not exists public.customers (
  email                       text primary key,
  shopify_customer_id         text,
  first_name                  text,
  last_name                   text,
  phone                       text,
  total_spent                 numeric(10,2) default 0,
  total_orders                integer       default 0,
  accepts_email_marketing     boolean       default false,
  accepts_sms_marketing       boolean       default false,
  accepts_whatsapp_marketing  boolean       default false,
  tax_exempt                  boolean       default false,
  tags                        text,
  note                        text,
  address                     jsonb,
  source                      text not null default 'shopify',
  updated_at                  timestamptz not null default now()
);

create index if not exists customers_total_spent_idx on public.customers (total_spent desc);

-- Service-role only, same as orders — no public policy needed.
alter table public.customers enable row level security;
