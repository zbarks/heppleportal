-- ============================================================
--  HEPPLE PORTAL — history + insights upgrade
--  Run once in Supabase → SQL Editor. Safe to re-run.
--
--  Adds:
--    1. gift_message / has_gift_card columns (documents what's
--       already in your live DB so schema.sql matches reality)
--    2. source column   — distinguishes 'stripe' vs 'shopify'
--    3. product_leaderboard()  RPC — whole-table, not windowed
--    4. customer_summary()     RPC — spend + repeat purchases
--
--  The RPCs run server-side over EVERY row, so they stay
--  correct no matter how much Shopify history you import and
--  no matter what date window the portal is showing.
-- ============================================================

-- ---- 1 + 2. columns -----------------------------------------
alter table public.orders add column if not exists gift_message  text;
alter table public.orders add column if not exists has_gift_card boolean not null default false;
alter table public.orders add column if not exists source        text    not null default 'stripe';

create index if not exists orders_source_idx on public.orders (source);

-- ---- 3. product leaderboard (whole table) -------------------
-- Unnests the items jsonb array and aggregates units / revenue
-- / distinct orders per product. Mirrors the JS shape the
-- frontend already expects: { slug, name, sku, units, revenue, orders }
create or replace function public.product_leaderboard()
returns table (
  slug    text,
  name    text,
  sku     text,
  units   bigint,
  revenue numeric,
  orders  bigint
)
language sql
stable
as $$
  select
    coalesce(nullif(item->>'slug', ''), item->>'name')                       as slug,
    max(item->>'name')                                                       as name,
    coalesce(max(nullif(item->>'sku', '')), '')                              as sku,
    sum(coalesce((item->>'qty')::numeric, 1))::bigint                        as units,
    round(sum(coalesce((item->>'qty')::numeric, 1)
            * coalesce((item->>'price')::numeric, 0)), 2)                    as revenue,
    count(distinct o.id)::bigint                                             as orders
  from public.orders o
  cross join lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) as item
  where coalesce(item->>'name', '') not in ('', 'Unknown item')
  group by 1
  order by units desc;
$$;

-- ---- 4. customer summary (spend + repeat purchases) ---------
-- One row per email: order count, lifetime spend, first/last order.
-- Pass min_orders => 2 to get repeat customers only.
create or replace function public.customer_summary(min_orders int default 1)
returns table (
  email        text,
  name         text,
  orders       bigint,
  spent        numeric,
  first_order  timestamptz,
  last_order   timestamptz
)
language sql
stable
as $$
  select
    customer_email                       as email,
    max(customer_name)                   as name,
    count(*)::bigint                     as orders,
    round(sum(coalesce(total, 0)), 2)    as spent,
    min(created_at)                      as first_order,
    max(created_at)                      as last_order
  from public.orders
  where customer_email is not null and customer_email <> ''
  group by customer_email
  having count(*) >= min_orders
  order by spent desc;
$$;

-- These run with the service-role key from your serverless
-- functions, which bypasses RLS — no public policy needed.
