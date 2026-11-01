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
  role text not null default 'seller' check (role in ('admin', 'seller', 'purchaser')),
  active boolean not null default false,
  -- Administrator belgilagan ruxsatlar (bo'sh bo'lsa — rolning odatiy ruxsatlari)
  perms text[],
  created_at timestamptz not null default now()
);
-- Avvalgi versiyadan yangilashda: ruxsatlar ustuni va "Ta'minot xodimi" roli
alter table public.profiles add column if not exists perms text[];
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'seller', 'purchaser'));

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- Ruxsat bormi: administrator — hammasi; boshqalar — belgilangan ruxsatlar yoki rolning odatiylari
-- (dasturdagi ROLE_PERMS bilan bir xil). Ruxsatlar: sale, enter, purchase, stockOps, products, costs, money, reports
create or replace function public.has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and active and (
      role = 'admin' or p = any(coalesce(perms, case role
        when 'seller' then array['sale', 'enter']
        when 'purchaser' then array['purchase', 'enter', 'products', 'costs']
        else array[]::text[] end))));
$$;

-- Hujjat turi uchun kerakli ruxsat
create or replace function public.doc_perm(t text) returns text
language sql immutable as $$
  select case
    when t in ('order', 'sale', 'salesReturn') then 'sale'
    when t in ('purchaseOrder', 'receipt', 'purchaseReturn') then 'purchase'
    when t = 'enter' then 'enter'
    when t in ('writeoff', 'move', 'inventory') then 'stockOps'
  end;
$$;

-- Hujjat bilan ishlash mumkinmi (inventarizatsiya yakunida kirim va hisobdan chiqarish ham yaratiladi)
create or replace function public.can_doc(t text) returns boolean
language sql stable as $$
  select public.has_perm(public.doc_perm(t)) or (t in ('enter', 'writeoff') and public.has_perm('stockOps'));
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

-- Login yaratish (elektron pochtasiz). Birinchi login — har kim (administrator bo'ladi),
-- keyingilarini faqat administrator yaratadi. Supabase'dagi «Confirm email» sozlamasiga bog'liq emas.
create or replace function public.create_login(p_email text, p_password text, p_name text) returns uuid
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  uid uuid := gen_random_uuid();
  em text := lower(trim(p_email));
begin
  perform pg_advisory_xact_lock(424242);
  if exists (select 1 from public.profiles) and not public.is_admin() then
    raise exception 'Ruxsat yo''q';
  end if;
  if coalesce(length(p_password), 0) < 6 then
    raise exception 'Parol kamida 6 belgidan iborat bo''lishi kerak';
  end if;
  if exists (select 1 from auth.users where email = em) then
    raise exception 'Bu login band';
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('name', p_name), now(), now(),
    '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text,
    jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
  return uid;
end;
$$;
revoke execute on function public.create_login(text, text, text) from public;
grant execute on function public.create_login(text, text, text) to anon, authenticated;

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

-- Mahsulotlar: hamma ko'radi, "Mahsulotlar" ruxsati borlar o'zgartiradi. Omborlar — faqat administrator
drop policy if exists products_select on public.products;
create policy products_select on public.products for select to authenticated using (public.is_active());
drop policy if exists products_write on public.products;
create policy products_write on public.products for all to authenticated
  using (public.has_perm('products')) with check (public.has_perm('products'));

-- Kelish narxlari — faqat "Tannarx" ruxsati borlarga yuboriladi
drop policy if exists costs_all on public.product_costs;
create policy costs_all on public.product_costs for all to authenticated
  using (public.has_perm('costs')) with check (public.has_perm('costs'));

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

-- Kontragentlar: savdo xodimi — mijozlarni, xarid xodimi — ta'minotchilarni ko'radi va qo'shadi
drop policy if exists cp_select on public.counterparties;
create policy cp_select on public.counterparties for select to authenticated
  using (public.is_admin() or public.has_perm('money')
    or (kind in ('customer', 'both') and public.has_perm('sale'))
    or (kind in ('supplier', 'both') and (public.has_perm('purchase') or public.has_perm('products'))));
drop policy if exists cp_insert on public.counterparties;
create policy cp_insert on public.counterparties for insert to authenticated
  with check (public.is_admin()
    or (kind = 'customer' and public.has_perm('sale'))
    or (kind = 'supplier' and (public.has_perm('purchase') or public.has_perm('products'))));
drop policy if exists cp_update on public.counterparties;
create policy cp_update on public.counterparties for update to authenticated
  using (public.is_admin() or (kind = 'customer' and public.has_perm('sale')) or (kind = 'supplier' and public.has_perm('purchase')))
  with check (public.is_admin() or (kind = 'customer' and public.has_perm('sale')) or (kind = 'supplier' and public.has_perm('purchase')));
drop policy if exists cp_delete on public.counterparties;
create policy cp_delete on public.counterparties for delete to authenticated using (public.is_admin());

-- Hujjatlar: xodim faqat ruxsati bor turdagi hujjatlarni ko'radi, o'z nomidan yaratadi, o'chira olmaydi
drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated
  using (public.is_admin() or public.can_doc(type));
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (public.is_admin() or (public.can_doc(type) and user_id = auth.uid()::text));
-- Buyurtma asosida jo'natish yaratilganda buyurtma holati o'zgaradi, shuning uchun
-- sotuvchi boshqa sotuvchining savdo hujjatini ham yangilay oladi (dastur buni faqat holat uchun qiladi)
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (public.is_admin() or public.can_doc(type))
  with check (public.is_admin() or public.can_doc(type));
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (public.is_admin());

-- To'lovlar: "Pul" ruxsati — hammasi; savdo xodimi — faqat mijozlar bilan bog'liq to'lovlar
drop policy if exists pay_select on public.payments;
create policy pay_select on public.payments for select to authenticated
  using (public.is_admin() or public.has_perm('money') or (public.has_perm('sale') and public.is_customer(counterparty_id))
    or (public.has_perm('expenses') and dir = 'out' and counterparty_id is null));
drop policy if exists pay_insert on public.payments;
create policy pay_insert on public.payments for insert to authenticated
  with check (public.is_admin() or (user_id = auth.uid()::text
    and (public.has_perm('money') or (public.has_perm('sale') and public.is_customer(counterparty_id))
      or (public.has_perm('expenses') and dir = 'out' and counterparty_id is null))));
drop policy if exists pay_update on public.payments;
create policy pay_update on public.payments for update to authenticated
  using (public.has_perm('money')) with check (public.has_perm('money'));
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
  if not public.is_admin() and not (
    public.can_doc(kind)
    or (kind = 'payIn' and (public.has_perm('sale') or public.has_perm('money')))
    or (kind = 'payOut' and (public.has_perm('sale') or public.has_perm('money') or public.has_perm('expenses')))
  ) then
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
  with check (bucket_id = 'photos' and public.has_perm('products'));
drop policy if exists photos_update on storage.objects;
create policy photos_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and public.has_perm('products'));
drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.has_perm('products'));
drop policy if exists photos_select on storage.objects;
create policy photos_select on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.has_perm('products'));

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

-- ---------- Ma'lumot yo'qolmasligi uchun himoya ----------

-- O'zgarishlar tarixi: har bir yozuv o'zgartirilganda yoki o'chirilganda uning avvalgi holati shu yerda qoladi.
-- Xato bilan o'chirilgan yoki buzilgan mahsulot, hujjat, to'lovni istalgan vaqtda qaytarish mumkin.
-- Dasturdan bu jadvalga yozish yoki undan o'chirish mumkin emas; faqat administrator o'qiy oladi.
create table if not exists public.history (
  id bigserial primary key,
  tbl text not null,
  row_id text not null,
  op text not null,
  data jsonb,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index if not exists history_row_idx on public.history (tbl, row_id, changed_at desc);
create index if not exists history_at_idx on public.history (changed_at desc);
alter table public.history enable row level security;
revoke all on public.history from anon, authenticated;
grant select on public.history to authenticated;
drop policy if exists history_select on public.history;
create policy history_select on public.history for select to authenticated using (public.is_admin());

create or replace function public.keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.data is not distinct from new.data then
    return null;
  end if;
  insert into public.history (tbl, row_id, op, data, changed_by)
  values (tg_table_name, old.id, lower(tg_op), old.data, auth.uid());
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['products', 'product_costs', 'warehouses', 'counterparties', 'docs', 'payments', 'settings'] loop
    execute format('drop trigger if exists keep_history on public.%I', t);
    execute format('create trigger keep_history after update or delete on public.%I for each row execute function public.keep_history()', t);
  end loop;
end $$;

-- Har kungi server zaxirasi jurnali (supabase/functions/daily-backup)
create table if not exists public.backup_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  ok boolean not null,
  file text,
  bytes integer,
  telegram text,
  error text
);
alter table public.backup_log enable row level security;
revoke all on public.backup_log from anon, authenticated;
grant select on public.backup_log to authenticated;
drop policy if exists backup_log_select on public.backup_log;
create policy backup_log_select on public.backup_log for select to authenticated using (public.is_admin());

-- Zaxira fayllari uchun yopiq xotira (ochiq havola yo'q; dastur foydalanuvchilari ham o'chira olmaydi)
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;
drop policy if exists backups_select on storage.objects;
create policy backups_select on storage.objects for select to authenticated
  using (bucket_id = 'backups' and public.is_admin());

-- Har kecha soat 02:00 da (Toshkent vaqti) server zaxirasini ishga tushirish.
-- <PROJECT_URL> va <ANON_KEY> o'rniga loyihangiz ma'lumotlarini yozing (Project Settings → API).
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select cron.schedule('daily-backup', '0 21 * * *', $cron$
--   select net.http_post(url := '<PROJECT_URL>/functions/v1/daily-backup',
--     headers := '{"Content-Type": "application/json", "Authorization": "Bearer <ANON_KEY>"}'::jsonb, body := '{}'::jsonb);
-- $cron$);
revoke execute on function public.handle_new_user(), public.keep_history() from public, anon, authenticated;

-- Bir martalik xizmat kalitlari (supabase/functions/tg-topics kabi xizmat funksiyalari uchun)
create table if not exists public.ops_nonce (id text primary key, created_at timestamptz not null default now());
alter table public.ops_nonce enable row level security;
revoke all on public.ops_nonce from anon, authenticated;

-- ---------- Yetkazib berish: shofyorlar Telegram bot orqali ----------
-- Bot webhook'i (supabase/functions/tg-bot) shu jadvallardan foydalanadi; dastur foydalanuvchilari
-- faqat o'qiy oladigan qismlarni ko'radi, yozish — faqat server funksiyasi (service_role).

-- Botga yozgan chatlar (guruh/shaxsiy ID ni aniqlash uchun — webhook yoqilgach getUpdates ishlamaydi)
create table if not exists public.tg_chats (
  chat_id text primary key,
  type text,
  title text,
  username text,
  is_forum boolean,
  last_text text,
  updated_at timestamptz not null default now()
);
alter table public.tg_chats enable row level security;
revoke all on public.tg_chats from anon, authenticated;
grant select on public.tg_chats to authenticated;
drop policy if exists tg_chats_select on public.tg_chats;
create policy tg_chats_select on public.tg_chats for select to authenticated using (public.is_admin());

-- Shofyor ↔ Telegram chat bog'lanishi (shofyor botdagi havola orqali o'zi ulanadi)
create table if not exists public.driver_chats (
  driver_id text primary key,
  chat_id text not null,
  tg_name text,
  updated_at timestamptz not null default now()
);
alter table public.driver_chats enable row level security;
revoke all on public.driver_chats from anon, authenticated;
grant select on public.driver_chats to authenticated;
drop policy if exists driver_chats_select on public.driver_chats;
create policy driver_chats_select on public.driver_chats for select to authenticated using (public.is_active());

-- Bot sirlari va suhbat holati — mijoz dasturiga umuman ko'rinmaydi
create table if not exists public.bot_private (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.bot_private enable row level security;
revoke all on public.bot_private from anon, authenticated;

-- Server (bot) uchun hujjat raqami — faqat service_role chaqira oladi
create or replace function public.next_no_srv(kind text, prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Faqat server';
  end if;
  insert into public.counters (id, value) values (kind, 1)
  on conflict (id) do update set value = public.counters.value + 1
  returning value into n;
  return prefix || '-' || lpad(n::text, 5, '0');
end;
$$;
revoke execute on function public.next_no_srv(text, text) from public, anon, authenticated;
grant execute on function public.next_no_srv(text, text) to service_role;

-- Shofyor olib kelgan pulni qabul qilish: pul kimga topshirilishi kerak bo'lsa o'sha (yoki administrator)
create or replace function public.accept_handover(pid text) returns void
language plpgsql security definer set search_path = public as $$
declare
  d jsonb;
begin
  select data into d from public.payments where id = pid for update;
  if d is null or d -> 'handover' is null then
    raise exception 'Topilmadi';
  end if;
  if not (public.is_admin() or (public.is_active() and d -> 'handover' ->> 'to' = auth.uid()::text)) then
    raise exception 'Ruxsat yo''q';
  end if;
  update public.payments
    set data = jsonb_set(d, '{handover}', (d -> 'handover') || jsonb_build_object('status', 'received', 'receivedAt', now(), 'receivedBy', auth.uid()::text))
    where id = pid;
end;
$$;
revoke execute on function public.accept_handover(text) from public, anon;
grant execute on function public.accept_handover(text) to authenticated;

-- «Kirim qilish» ruxsati bor xodim yangi mahsulot (va uning rasmini) qo'sha oladi; o'zgartirish/o'chirish — faqat «Mahsulotlar»
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'products' and policyname = 'products_insert_enter') then
    create policy products_insert_enter on public.products for insert to authenticated with check (public.has_perm('enter'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photos_insert_enter') then
    create policy photos_insert_enter on storage.objects for insert to authenticated with check (bucket_id = 'photos' and public.has_perm('enter'));
  end if;
end $$;
