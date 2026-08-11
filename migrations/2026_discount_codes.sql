-- =============================================================
--  Managed discount codes
--
--  Replaces the hardcoded PROMOS map in the site's api/_catalogue.js.
--  Codes are created and switched on/off from the portal (Discounts page);
--  the storefront validates them through api/promo-check, and api/checkout
--  applies the money server-side before the session reaches Stripe.
--
--  Already applied to the Hepple Supabase project on 2026-08-11.
--  Safe to re-run: every statement is guarded.
--  Designed by Barker Digital
-- =============================================================

-- -------------------------------------------------------------
--  1. The codes
-- -------------------------------------------------------------
create table if not exists public.discount_codes (
  id                bigint generated always as identity primary key,
  code              text          not null,
  kind              text          not null check (kind in ('percent','fixed')),
  value             numeric(10,2) not null check (value > 0),
  label             text,                       -- shown in the cart when applied
  description       text,                       -- internal note, portal only
  free_shipping     boolean       not null default false,
  once_per_customer boolean       not null default true,
  stripe_coupon_id  text,                       -- optional; else discounted inline
  active            boolean       not null default true,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  constraint discount_codes_percent_max check (kind <> 'percent' or value <= 100)
);

comment on column public.discount_codes.once_per_customer is
  'Enforced against promo_redemptions.posthog_distinct_id — per browser, not per person.';
comment on column public.discount_codes.stripe_coupon_id is
  'When set, checkout.js applies it via params.discounts instead of discounting line items inline.';

-- Codes are case-insensitive, stored trimmed + uppercase. Labels are
-- auto-composed when the portal leaves the field blank.
create or replace function public.discount_codes_normalise()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.code := upper(btrim(new.code));
  new.updated_at := now();

  if new.label is null or btrim(new.label) = '' then
    new.label := case
      when new.kind = 'percent' then trim(to_char(new.value, 'FM999990.99')) || '% OFF'
      else '£' || trim(to_char(new.value, 'FM999990.00')) || ' OFF'
    end
    || case when new.free_shipping then ' + FREE UK DELIVERY' else '' end;
  else
    new.label := upper(btrim(new.label));
  end if;

  return new;
end $$;

drop trigger if exists trg_discount_codes_normalise on public.discount_codes;
create trigger trg_discount_codes_normalise
  before insert or update on public.discount_codes
  for each row execute function public.discount_codes_normalise();

create unique index if not exists discount_codes_code_uniq
  on public.discount_codes (upper(code));

alter table public.discount_codes enable row level security;
revoke all on public.discount_codes from anon, authenticated;  -- service role only

-- -------------------------------------------------------------
--  2. Tie discounts to orders
-- -------------------------------------------------------------
alter table public.orders
  add column if not exists discount_amount numeric(10,2) not null default 0;

alter table public.promo_redemptions
  add column if not exists order_id        bigint,
  add column if not exists discount_amount numeric(10,2),
  add column if not exists subtotal_before numeric(10,2);

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'promo_redemptions_order_id_fkey') then
    alter table public.promo_redemptions
      add constraint promo_redemptions_order_id_fkey
      foreign key (order_id) references public.orders(id) on delete set null;
  end if;
end $$;

create unique index if not exists promo_redemptions_session_uniq
  on public.promo_redemptions (stripe_session_id);
create index if not exists promo_redemptions_code_idx
  on public.promo_redemptions (upper(code));
create index if not exists orders_promo_code_idx
  on public.orders (upper(promo_code)) where promo_code is not null;

-- Link any redemptions written before this migration
update public.promo_redemptions r
set order_id = o.id
from public.orders o
where r.stripe_session_id = o.stripe_session_id and r.order_id is null;

-- -------------------------------------------------------------
--  3. Reporting (the portal's two Discounts views)
-- -------------------------------------------------------------

-- Every order that used a code.
create or replace view public.discount_code_orders
with (security_invoker = true) as
select
  upper(o.promo_code) as code,
  dc.id               as discount_code_id,
  dc.kind             as code_kind,
  dc.value            as code_value,
  dc.active           as code_active,
  o.id                as order_id,
  o.created_at, o.customer_name, o.customer_email, o.item_count,
  o.subtotal, o.discount_amount, o.shipping, o.total,
  o.payment_status, o.fulfilled, o.stripe_session_id
from public.orders o
left join public.discount_codes dc on upper(dc.code) = upper(o.promo_code)
where o.promo_code is not null and btrim(o.promo_code) <> '';

-- One row per code, including codes nobody has used yet.
create or replace view public.discount_code_stats
with (security_invoker = true) as
select
  dc.id, dc.code, dc.kind, dc.value, dc.label, dc.description,
  dc.free_shipping, dc.once_per_customer, dc.stripe_coupon_id,
  dc.active, dc.created_at,
  coalesce(u.times_used, 0)     as times_used,
  coalesce(u.total_discount, 0) as total_discount,
  coalesce(u.total_revenue, 0)  as total_revenue,
  u.first_used_at, u.last_used_at
from public.discount_codes dc
left join (
  select upper(promo_code) as code,
         count(*)             as times_used,
         sum(discount_amount) as total_discount,
         sum(total)           as total_revenue,
         min(created_at)      as first_used_at,
         max(created_at)      as last_used_at
  from public.orders
  where promo_code is not null and btrim(promo_code) <> ''
  group by 1
) u on u.code = upper(dc.code);

revoke all on public.discount_code_orders from anon, authenticated;
revoke all on public.discount_code_stats  from anon, authenticated;

-- -------------------------------------------------------------
--  4. Validation
--
--  One call answers everything the site needs: is the code real, what does
--  it do, has this visitor already redeemed it, and what's the discount on
--  this subtotal. Service role only — the browser never calls it directly,
--  because the price that reaches Stripe has to be derived server-side.
-- -------------------------------------------------------------
drop function if exists public.validate_discount_code(text, numeric);
drop function if exists public.validate_discount_code(text, numeric, text);

create function public.validate_discount_code(
  p_code     text,
  p_subtotal numeric default null,
  p_ph_id    text    default null
)
returns table (
  valid            boolean,
  code             text,
  label            text,
  kind             text,
  value            numeric,
  free_shipping    boolean,
  stripe_coupon_id text,
  already_used     boolean,
  discount_amount  numeric,
  new_subtotal     numeric,
  reason           text
)
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare
  dc   public.discount_codes%rowtype;
  used boolean := false;
  d    numeric(10,2);
begin
  if p_code is null or btrim(p_code) = '' then
    return query select false, null::text, null::text, null::text, null::numeric,
                        null::boolean, null::text, false, null::numeric, p_subtotal, 'Enter a code';
    return;
  end if;

  select * into dc from public.discount_codes
  where upper(discount_codes.code) = upper(btrim(p_code));

  if not found or not dc.active then
    return query select false, upper(btrim(p_code)), null::text, null::text, null::numeric,
                        null::boolean, null::text, false, null::numeric, p_subtotal,
                        'CODE NOT RECOGNISED';
    return;
  end if;

  if dc.once_per_customer and p_ph_id is not null and btrim(p_ph_id) <> '' then
    select exists (
      select 1 from public.promo_redemptions r
      where upper(r.code) = upper(dc.code)
        and r.posthog_distinct_id = p_ph_id
    ) into used;
  end if;

  if used then
    return query select false, dc.code, dc.label, dc.kind, dc.value, dc.free_shipping,
                        dc.stripe_coupon_id, true, null::numeric, p_subtotal,
                        'YOU''VE ALREADY USED THIS CODE';
    return;
  end if;

  if p_subtotal is null then
    return query select true, dc.code, dc.label, dc.kind, dc.value, dc.free_shipping,
                        dc.stripe_coupon_id, false, null::numeric, null::numeric, null::text;
    return;
  end if;

  d := case when dc.kind = 'percent' then round(p_subtotal * dc.value / 100.0, 2)
            else dc.value end;
  d := least(greatest(d, 0), round(p_subtotal, 2));   -- never exceed the cart

  return query select true, dc.code, dc.label, dc.kind, dc.value, dc.free_shipping,
                      dc.stripe_coupon_id, false, d, round(p_subtotal, 2) - d, null::text;
end $$;

revoke all     on function public.validate_discount_code(text, numeric, text) from public;
revoke execute on function public.validate_discount_code(text, numeric, text) from anon, authenticated;
grant  execute on function public.validate_discount_code(text, numeric, text) to service_role;

-- -------------------------------------------------------------
--  5. Carry over the previously hardcoded school code
-- -------------------------------------------------------------
insert into public.discount_codes (code, kind, value, free_shipping, label, description)
values ('MYSCHOOL10', 'percent', 10, true, '10% OFF + FREE UK DELIVERY',
        'Migrated from the hardcoded PROMOS map in api/_catalogue.js')
on conflict do nothing;

-- Backfill the one historic order that used it (£112.41 → £101.17)
update public.orders
set discount_amount = 11.24
where promo_code = 'MYSCHOOL10' and discount_amount = 0 and subtotal = 101.17;

update public.promo_redemptions r
set discount_amount = 11.24, subtotal_before = 112.41
from public.orders o
where r.order_id = o.id and o.promo_code = 'MYSCHOOL10' and r.discount_amount is null;
