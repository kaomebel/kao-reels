-- Yetkazib berish (shofyorlar Telegram bot orqali) uchun jadvallar.
-- Supabase → SQL Editor → New query → shu faylni to'liq joylang → Run. Qayta ishga tushirish xavfsiz.
create table if not exists public.tg_chats (
  chat_id text primary key, type text, title text, username text, is_forum boolean, last_text text,
  updated_at timestamptz not null default now()
);
alter table public.tg_chats enable row level security;
revoke all on public.tg_chats from anon, authenticated;
grant select on public.tg_chats to authenticated;
drop policy if exists tg_chats_select on public.tg_chats;
create policy tg_chats_select on public.tg_chats for select to authenticated using (public.is_admin());

create table if not exists public.driver_chats (
  driver_id text primary key, chat_id text not null, tg_name text,
  updated_at timestamptz not null default now()
);
alter table public.driver_chats enable row level security;
revoke all on public.driver_chats from anon, authenticated;
grant select on public.driver_chats to authenticated;
drop policy if exists driver_chats_select on public.driver_chats;
create policy driver_chats_select on public.driver_chats for select to authenticated using (public.is_active());

create table if not exists public.bot_private (
  id text primary key, data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.bot_private enable row level security;
revoke all on public.bot_private from anon, authenticated;

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

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'driver_chats') then
    alter publication supabase_realtime add table public.driver_chats;
  end if;
end $$;

-- Har kuni ertalab 08:57 da (Toshkent) yopilmagan sotuvlar ro'yxati administratorning Telegramiga:
-- insert into public.bot_private (id, data) values ('cron', jsonb_build_object('key', encode(gen_random_bytes(16), 'hex'))) on conflict (id) do nothing;
-- select cron.schedule('open-sales-remind', '57 3 * * *', $cron$
--   select net.http_post(url := '<PROJECT_URL>/functions/v1/tg-bot', headers := '{"Content-Type": "application/json"}'::jsonb,
--     body := jsonb_build_object('action', 'remind', 'key', (select data->>'key' from public.bot_private where id = 'cron')), timeout_milliseconds := 60000);
-- $cron$);

-- Narxi o'zgargan mahsulotning etiketkasi almashtirildi — eslatmani olib tashlash (har qanday faol xodim)
create or replace function public.mark_label_done(pid text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_active() then
    raise exception 'Ruxsat yo''q';
  end if;
  update public.products set data = data - 'labelDue' where id = pid;
end;
$$;
grant execute on function public.mark_label_done(text) to authenticated;
