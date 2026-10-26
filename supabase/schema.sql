-- =====================================================================
-- Biznes Tizim — Supabase (PostgreSQL) sxemasi
--
-- Supabase panelida: SQL Editor → New query → shu faylni to'liq joylang → Run.
-- Qayta ishga tushirish xavfsiz (mavjud jadval va ma'lumotlarga tegmaydi).
--
-- Har bir jadvalda yozuv `data` (jsonb) ustunida saqlanadi; ruxsatlar uchun
-- kerakli maydonlar (turi, kontragent, muallif) undan avtomatik ajratib olinadi.
-- Bu oddiy PostgreSQL — istalgan boshqa PostgreSQL serverga pg_dump bilan ko'chadi.
-- =====================================================================

-- ---------- Foydalanuvchilar ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  login text not null default '',
  role text not null default 'seller' check (role in ('admin', 'seller')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- Birinchi ro'yxatdan o'tgan foydalanuvchi — faol administrator.
-- Keyingilari bloklangan sotuvchi bo'lib yaratiladi va ularni administrator faollashtiradi:
-- shunda begona odam ro'yxatdan o'tsa ham hech narsani ko'ra olmaydi.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  first_user boolean;
begin
  perform pg_advisory_xact_lock(424242);
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, name, login, role, active)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    coalesce(new.email, ''),
    case when first_user then 'admin' else 'seller' end,
    first_user
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Kirish oynasi birinchi ishga tushirishni aniqlashi uchun (kirmasdan chaqiriladi)
create or replace function public.has_users() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles);
$$;

-- ---------- Asosiy jadvallar ----------

create table if not exists public.products (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Kelish narxi alohida jadvalda — sotuvchilarga umuman yuborilmaydi
create table if not exists public.product_costs (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.warehouses (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.counterparties (
  id text primary key,
  data jsonb not null,
  kind text generated always as (data ->> 'kind') stored,
  updated_at timestamptz not null default now()
);

create table if not exists public.docs (
  id text primary key,
  data jsonb not null,
  type text generated always as (data ->> 'type') stored,
  user_id text generated always as (data ->> 'userId') stored,
  doc_date text generated always as (data ->> 'date') stored,
  updated_at timestamptz not null default now()
);
create index if not exists docs_type_idx on public.docs (type);
create index if not exists docs_date_idx on public.docs (doc_date);

create table if not exists public.payments (
  id text primary key,
  data jsonb not null,
  dir text generated always as (data ->> 'dir') stored,
  counterparty_id text generated always as (data ->> 'counterpartyId') stored,
  user_id text generated always as (data ->> 'userId') stored,
  updated_at timestamptz not null default now()
);

-- Kategoriyalar, kompaniya ma'lumotlari, Telegram sozlamalari
create table if not exists public.settings (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Hujjat raqamlari hisoblagichi
create table if not exists public.counters (
  id text primary key,
  value integer not null default 0
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['products', 'product_costs', 'warehouses', 'counterparties', 'docs', 'payments', 'settings'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------- Ruxsatlar (Row Level Security) ----------

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.product_costs enable row level security;
alter table public.warehouses enable row level security;
alter table public.counterparties enable row level security;
alter table public.docs enable row level security;
alter table public.payments enable row level security;
alter table public.settings enable row level security;
alter table public.counters enable row level security;

revoke all on public.profiles, public.products, public.product_costs, public.warehouses,
  public.counterparties, public.docs, public.payments, public.settings, public.counters from anon;
grant select, insert, update, delete on public.products, public.product_costs, public.warehouses,
  public.counterparties, public.docs, public.payments, public.settings to authenticated;
grant select, update on public.profiles to authenticated;

-- Sotuvchi ishlaydigan hujjat turlari
create or replace function public.is_sales_type(t text) returns boolean
language sql immutable as $$
  select t in ('order', 'sale', 'salesReturn');
$$;

create or replace function public.is_customer(cid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.counterparties where id = cid and kind in ('customer', 'both'));
$$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (public.is_active() or id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Mahsulotlar va omborlar: hamma ko'radi, faqat administrator o'zgartiradi
drop policy if exists products_select on public.products;
create policy products_select on public.products for select to authenticated using (public.is_active());
drop policy if exists products_write on public.products;
create policy products_write on public.products for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists costs_all on public.product_costs;
create policy costs_all on public.product_costs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists warehouses_select on public.warehouses;
create policy warehouses_select on public.warehouses for select to authenticated using (public.is_active());
drop policy if exists warehouses_write on public.warehouses;
create policy warehouses_write on public.warehouses for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Sozlamalar: Telegram tokeni faqat administratorga ko'rinadi
drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings for select to authenticated
  using (public.is_admin() or (public.is_active() and id <> 'telegram'));
drop policy if exists settings_write on public.settings;
create policy settings_write on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Kontragentlar: sotuvchi faqat mijozlarni ko'radi va qo'shadi
drop policy if exists cp_select on public.counterparties;
create policy cp_select on public.counterparties for select to authenticated
  using (public.is_admin() or (public.is_active() and kind in ('customer', 'both')));
drop policy if exists cp_insert on public.counterparties;
create policy cp_insert on public.counterparties for insert to authenticated
  with check (public.is_admin() or (public.is_active() and kind = 'customer'));
drop policy if exists cp_update on public.counterparties;
create policy cp_update on public.counterparties for update to authenticated
  using (public.is_admin() or (public.is_active() and kind = 'customer'))
  with check (public.is_admin() or (public.is_active() and kind = 'customer'));
drop policy if exists cp_delete on public.counterparties;
create policy cp_delete on public.counterparties for delete to authenticated using (public.is_admin());

-- Hujjatlar: sotuvchi faqat savdo hujjatlarini ko'radi, o'z nomidan yaratadi, o'chira olmaydi
drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated
  using (public.is_admin() or (public.is_active() and public.is_sales_type(type)));
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (public.is_admin() or (public.is_active() and public.is_sales_type(type) and user_id = auth.uid()::text));
-- Buyurtma asosida jo'natish yaratilganda buyurtma holati o'zgaradi, shuning uchun
-- sotuvchi boshqa sotuvchining savdo hujjatini ham yangilay oladi (dastur buni faqat holat uchun qiladi)
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (public.is_admin() or (public.is_active() and public.is_sales_type(type)))
  with check (public.is_admin() or (public.is_active() and public.is_sales_type(type)));
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (public.is_admin());

-- To'lovlar: sotuvchi faqat mijozlar bilan bog'liq to'lovlarni ko'radi va kiritadi
drop policy if exists pay_select on public.payments;
create policy pay_select on public.payments for select to authenticated
  using (public.is_admin() or (public.is_active() and public.is_customer(counterparty_id)));
drop policy if exists pay_insert on public.payments;
create policy pay_insert on public.payments for insert to authenticated
  with check (public.is_admin() or (public.is_active() and user_id = auth.uid()::text and public.is_customer(counterparty_id)));
drop policy if exists pay_update on public.payments;
create policy pay_update on public.payments for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists pay_delete on public.payments;
create policy pay_delete on public.payments for delete to authenticated using (public.is_admin());

-- ---------- Server funksiyalari ----------

-- Navbatdagi hujjat raqami (bir vaqtda ishlayotgan sotuvchilarda takrorlanmaydi)
create or replace function public.next_no(kind text, prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if not public.is_active() then
    raise exception 'Ruxsat yo''q';
  end if;
  if not public.is_admin() and kind not in ('order', 'sale', 'salesReturn', 'payIn', 'payOut') then
    raise exception 'Ruxsat yo''q';
  end if;
  insert into public.counters (id, value) values (kind, 1)
  on conflict (id) do update set value = public.counters.value + 1
  returning value into n;
  return prefix || '-' || lpad(n::text, 5, '0');
end;
$$;

-- Zaxiradan tiklashda hisoblagichlarni moslash
create or replace function public.set_counters(seq jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  k text;
  v jsonb;
begin
  if not public.is_admin() then
    raise exception 'Ruxsat yo''q';
  end if;
  for k, v in select * from jsonb_each(seq) loop
    insert into public.counters (id, value) values (k, (v #>> '{}')::integer)
    on conflict (id) do update set value = greatest(public.counters.value, excluded.value);
  end loop;
end;
$$;

-- Ombor qoldiqlari. Sotuvchi xarid hujjatlarini ko'rmaydi, shuning uchun qoldiq serverda hisoblanadi.
create or replace function public.stock_levels() returns table (product_id text, warehouse_id text, qty numeric)
language sql stable security definer set search_path = public as $$
  with items as (
    select d.type,
           d.data ->> 'warehouseId' as wh,
           d.data ->> 'toWarehouseId' as wh2,
           it ->> 'productId' as pid,
           coalesce((it ->> 'qty')::numeric, 0) as q
    from public.docs d
    cross join lateral jsonb_array_elements(coalesce(d.data -> 'items', '[]'::jsonb)) it
    where public.is_active()
  )
  select pid, wh, sum(q * case type
           when 'receipt' then 1 when 'enter' then 1 when 'salesReturn' then 1
           when 'purchaseReturn' then -1 when 'sale' then -1 when 'writeoff' then -1 when 'move' then -1
           else 0 end)
  from items group by pid, wh
  union all
  select pid, wh2, sum(q) from items where type = 'move' group by pid, wh2;
$$;

-- Rasmlar egallagan joy (baytlarda) — Sozlamalardagi hisoblagich uchun
create or replace function public.photos_usage() returns bigint
language sql stable security definer set search_path = public, storage as $$
  select case when public.is_admin()
    then coalesce(sum((metadata ->> 'size')::bigint), 0) else 0 end
  from storage.objects where bucket_id = 'photos';
$$;

revoke execute on function public.next_no(text, text), public.set_counters(jsonb), public.stock_levels(), public.photos_usage() from anon, public;
grant execute on function public.next_no(text, text), public.set_counters(jsonb), public.stock_levels(), public.photos_usage() to authenticated;
grant execute on function public.has_users() to anon, authenticated;

-- ---------- Rasmlar xotirasi ----------

insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_admin());
drop policy if exists photos_update on storage.objects;
create policy photos_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and public.is_admin());
drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_admin());
drop policy if exists photos_select on storage.objects;
create policy photos_select on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_admin());

-- ---------- Jonli yangilanish (boshqa qurilmadagi o'zgarishlar darhol ko'rinadi) ----------

do $$
declare t text;
begin
  foreach t in array array['products', 'product_costs', 'warehouses', 'counterparties', 'docs', 'payments', 'settings', 'profiles'] loop
    if not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
