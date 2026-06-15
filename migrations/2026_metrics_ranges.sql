-- ============================================================
--  HEPPLE PORTAL — date ranges + cross-source revenue
--  Run once in Supabase → SQL Editor. Safe to re-run.
--
--  • Adds optional from_date / to_date to product_leaderboard
--    and customer_summary so every metric can be filtered by
--    range (NULL bounds = all time).
--  • Adds revenue_metrics / revenue_by_month / revenue_by_day,
--    which sum the WHOLE orders table — Stripe + imported
--    Shopify history together — so all-time revenue includes
--    your pre-migration Shopify takings as the base.
--
--  All bounds are half-open [from, to): from <= created_at < to.
-- ============================================================

-- ---- product leaderboard (now range-aware) ------------------
drop function if exists public.product_leaderboard();
drop function if exists public.product_leaderboard(timestamptz, timestamptz);
create function public.product_leaderboard(
  from_date timestamptz default null,
  to_date   timestamptz default null
)
returns table (slug text, name text, sku text, units bigint, revenue numeric, orders bigint)
language sql stable as $$
  select
    coalesce(nullif(item->>'slug', ''), item->>'name')                        as slug,
    max(item->>'name')                                                        as name,
    coalesce(max(nullif(item->>'sku', '')), '')                               as sku,
    sum(coalesce((item->>'qty')::numeric, 1))::bigint                         as units,
    round(sum(coalesce((item->>'qty')::numeric, 1)
            * coalesce((item->>'price')::numeric, 0)), 2)                     as revenue,
    count(distinct o.id)::bigint                                              as orders
  from public.orders o
  cross join lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) as item
  where coalesce(item->>'name', '') not in ('', 'Unknown item')
    and (from_date is null or o.created_at >= from_date)
    and (to_date   is null or o.created_at <  to_date)
  group by 1
  order by units desc;
$$;

-- ---- customer summary (now range-aware) ---------------------
drop function if exists public.customer_summary(int);
drop function if exists public.customer_summary(int, timestamptz, timestamptz);
create function public.customer_summary(
  min_orders int default 1,
  from_date  timestamptz default null,
  to_date    timestamptz default null
)
returns table (email text, name text, orders bigint, spent numeric, first_order timestamptz, last_order timestamptz)
language sql stable as $$
  select
    customer_email                       as email,
    max(customer_name)                   as name,
    count(*)::bigint                     as orders,
    round(sum(coalesce(total, 0)), 2)    as spent,
    min(created_at)                      as first_order,
    max(created_at)                      as last_order
  from public.orders
  where customer_email is not null and customer_email <> ''
    and (from_date is null or created_at >= from_date)
    and (to_date   is null or created_at <  to_date)
  group by customer_email
  having count(*) >= min_orders
  order by spent desc;
$$;

-- ---- headline metrics across ALL sources --------------------
drop function if exists public.revenue_metrics(timestamptz, timestamptz);
create function public.revenue_metrics(
  from_date timestamptz default null,
  to_date   timestamptz default null
)
returns table (
  revenue numeric, orders bigint, customers bigint, aov numeric,
  units bigint, first_order timestamptz, last_order timestamptz
)
language sql stable as $$
  with f as (
    select * from public.orders
    where (from_date is null or created_at >= from_date)
      and (to_date   is null or created_at <  to_date)
  )
  select
    round(coalesce(sum(total), 0), 2)                                  as revenue,
    count(*)::bigint                                                   as orders,
    count(distinct customer_email)::bigint                             as customers,
    case when count(*) > 0
         then round(coalesce(sum(total), 0) / count(*), 2) else 0 end  as aov,
    coalesce(sum(coalesce(item_count, 0)), 0)::bigint                  as units,
    min(created_at)                                                    as first_order,
    max(created_at)                                                    as last_order
  from f;
$$;

-- ---- revenue series (day + month) ---------------------------
drop function if exists public.revenue_by_month(timestamptz, timestamptz);
create function public.revenue_by_month(
  from_date timestamptz default null,
  to_date   timestamptz default null
)
returns table (month text, revenue numeric, orders bigint)
language sql stable as $$
  select
    to_char(date_trunc('month', created_at), 'YYYY-MM')  as month,
    round(coalesce(sum(total), 0), 2)                    as revenue,
    count(*)::bigint                                     as orders
  from public.orders
  where (from_date is null or created_at >= from_date)
    and (to_date   is null or created_at <  to_date)
  group by 1 order by 1;
$$;

drop function if exists public.revenue_by_day(timestamptz, timestamptz);
create function public.revenue_by_day(
  from_date timestamptz default null,
  to_date   timestamptz default null
)
returns table (day text, revenue numeric, orders bigint)
language sql stable as $$
  select
    to_char(date_trunc('day', created_at), 'YYYY-MM-DD')  as day,
    round(coalesce(sum(total), 0), 2)                     as revenue,
    count(*)::bigint                                      as orders
  from public.orders
  where (from_date is null or created_at >= from_date)
    and (to_date   is null or created_at <  to_date)
  group by 1 order by 1;
$$;
