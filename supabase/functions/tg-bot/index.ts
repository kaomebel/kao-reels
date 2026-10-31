// Telegram bot: shofyorlar bilan ishlash va bot chatlarini yozib borish.
//
// 1) Telegram webhook (sarlavhada maxfiy kalit) — bot xabarlari:
//    • /start d_<id> — shofyor o'z Telegramini dasturdagi shofyorga bog'laydi
//    • «🚚 Yo'lga chiqdim» — sotuv holati «Yo'lda»
//    • «📦 Yetkazib berdim» → majburiy surat → mijozdan olingan pul → sotuv yopiladi («Yetkazildi»),
//      pul to'lov sifatida yoziladi va mas'ul xodimga «qabul qilib ol» deb ko'rsatiladi
// 2) Dastur so'rovlari (foydalanuvchi JWT bilan):
//    • { action: 'setup' } — administrator: webhook'ni yoqadi
//    • { action: 'send', docId, driverId } — sotuv ma'lumotlarini shofyorga yuboradi
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SELF_URL = Deno.env.get("SUPABASE_URL")! + "/functions/v1/tg-bot";

const fmt = (n: number) => Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const money = (n: number) => `${fmt(n)} so'm`;
const fmtDate = (s?: string) => (s ? s.split("-").reverse().join(".") : "");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

async function settings(id: string) {
  const { data } = await sb.from("settings").select("data").eq("id", id).maybeSingle();
  return data?.data?.value;
}
async function priv(id: string) {
  const { data } = await sb.from("bot_private").select("data").eq("id", id).maybeSingle();
  return data?.data || {};
}
async function setPriv(id: string, data: unknown) {
  await sb.from("bot_private").upsert({ id, data, updated_at: new Date().toISOString() });
}
async function tgCall(token: string, method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({ ok: false, description: String(r.status) }));
}

// ---- Sotuv ma'lumotlari ----
async function docBundle(docId: string) {
  const { data: row } = await sb.from("docs").select("data").eq("id", docId).maybeSingle();
  const d = row?.data;
  if (!d) return null;
  const pids = [...new Set((d.items || []).map((i: any) => i.productId).filter(Boolean))];
  const { data: prods } = pids.length ? await sb.from("products").select("id,data").in("id", pids) : { data: [] };
  const pmap = new Map((prods || []).map((p: any) => [p.id, p.data]));
  const party = d.counterpartyId ? (await sb.from("counterparties").select("data").eq("id", d.counterpartyId).maybeSingle()).data?.data : null;
  const ids = [d.id];
  if (d.orderId) ids.push(d.orderId);
  const { data: pays } = await sb.from("payments").select("data").in("data->>docId", ids);
  const total = Math.max(0, (d.items || []).reduce((s: number, it: any) => s + it.qty * it.price, 0) - (d.discount || 0)) * (d.currency === "USD" ? d.rate || 0 : 1);
  const paid = (pays || []).reduce((s: number, p: any) => s + (p.data.dir === "in" ? p.data.amount : 0), 0);
  return { d, pmap, party, total, paid, rest: Math.max(0, total - paid) };
}

function orderText(b: NonNullable<Awaited<ReturnType<typeof docBundle>>>, company: any) {
  const { d, pmap, party, total, paid, rest } = b;
  const items = (d.items || []).map((it: any) => ` • ${esc(pmap.get(it.productId)?.name || it.name || "mahsulot")} × ${it.qty}${it.kitName ? ` <i>(${esc(it.kitName)})</i>` : ""}`).join("\n");
  const phone = party?.phone ? `\n📞 <b>${esc(party.phone)}</b>` : "";
  return `🚚 <b>Yetkazish: ${esc(d.no)}</b> (${fmtDate(d.date)})\n` +
    `👤 Mijoz: <b>${esc(party?.name || "")}</b>${phone}\n` +
    `📍 ${esc(d.address || "manzil ko'rsatilmagan")}\n` +
    (d.deliveryDate ? `🗓 Yetkazish sanasi: <b>${fmtDate(d.deliveryDate)}</b>\n` : "") +
    `📦 Mahsulotlar:\n${items}\n` +
    `💰 Jami: ${money(total)} · To'langan: ${money(paid)}\n` +
    (rest > 0 ? `💵 <b>Mijozdan olinadigan: ${money(rest)}</b>` : `✅ <b>To'liq to'langan — pul olinmaydi</b>`) +
    (d.note ? `\n📝 ${esc(d.note)}` : "") +
    (company?.phone ? `\n\n🏢 ${esc(company.name || "")} ${esc(company.phone)}` : "");
}

const orderKeyboard = (docId: string) => ({ inline_keyboard: [[{ text: "🚚 Yo'lga chiqdim", callback_data: `way:${docId}` }], [{ text: "📦 Yetkazib berdim", callback_data: `done:${docId}` }]] });

async function updateDoc(docId: string, patch: (d: any) => void) {
  const { data: row } = await sb.from("docs").select("data").eq("id", docId).maybeSingle();
  if (!row) return null;
  const d = row.data;
  patch(d);
  await sb.from("docs").update({ data: d }).eq("id", docId);
  return d;
}

async function driverOf(chatId: string) {
  const { data } = await sb.from("driver_chats").select("driver_id").eq("chat_id", chatId).maybeSingle();
  if (!data) return null;
  const drivers = (await settings("drivers")) || [];
  return drivers.find((x: any) => x.id === data.driver_id) || { id: data.driver_id, name: "Shofyor" };
}

// Yetkazish yakuni: sotuv yopiladi, olingan pul yoziladi, mas'ulga xabar
async function finishDelivery(tg: any, chatId: string, st: any, amount: number) {
  const drv = await driverOf(chatId);
  const b = await docBundle(st.docId);
  if (!b) return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: "Sotuv topilmadi." });
  const now = new Date().toISOString();
  await updateDoc(st.docId, (d) => {
    d.status = "delivered";
    d.delivered = { at: now, driverId: drv?.id, driverName: drv?.name, photos: st.photos || [], collected: amount };
  });
  if (amount > 0) {
    const { data: no } = await sb.rpc("next_no_srv", { kind: "payIn", prefix: "PK" });
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 14);
    const to = b.d.userId || null;
    await sb.from("payments").insert({ id, data: {
      id, no, dir: "in", date: now.slice(0, 10), counterpartyId: b.d.counterpartyId || null, docId: b.d.id, amount, method: "cash",
      purpose: "Mijozdan to'lov", note: `Shofyor ${drv?.name || ""} yetkazib berganda oldi`, userId: to,
      handover: { driverId: drv?.id, driverName: drv?.name, to, status: "pending", at: now },
    } });
  }
  await setPriv("state:" + chatId, {});
  const left = Math.max(0, b.rest - amount);
  await tgCall(tg.token, "sendMessage", { chat_id: chatId, parse_mode: "HTML",
    text: `✅ <b>${esc(b.d.no)}</b> yopildi. Rahmat!\n${amount > 0 ? `💵 Olingan pul: <b>${money(amount)}</b> — uni mas'ul xodimga topshiring.` : "Pul olinmadi."}${left > 0 ? `\n⚠️ Mijoz qarzi qoldi: ${money(left)}` : ""}` });
  // Administratorga hisobot (surat bilan)
  if (tg.backupChatId) {
    const cap = `📦 <b>${esc(b.d.no)}</b> yetkazildi\n🚚 Shofyor: ${esc(drv?.name || "")}\n👤 ${esc(b.party?.name || "")}\n💵 Olindi: ${money(amount)}${left > 0 ? `\n⚠️ Qarz qoldi: ${money(left)}` : ""}`;
    const ph = (st.photos || [])[0];
    if (ph) await tgCall(tg.token, "sendPhoto", { chat_id: tg.backupChatId, photo: ph, caption: cap, parse_mode: "HTML" });
    else await tgCall(tg.token, "sendMessage", { chat_id: tg.backupChatId, text: cap, parse_mode: "HTML" });
  }
}

async function onUpdate(tg: any, u: any) {
  const msg = u.message || u.edited_message;
  const chat = msg?.chat || u.my_chat_member?.chat || u.callback_query?.message?.chat;
  if (chat) {
    await sb.from("tg_chats").upsert({ chat_id: String(chat.id), type: chat.type, title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" "),
      username: chat.username || null, is_forum: !!chat.is_forum, last_text: msg?.text?.slice(0, 200) || null, updated_at: new Date().toISOString() });
  }
  // Tugmalar
  if (u.callback_query) {
    const cq = u.callback_query;
    const chatId = String(cq.message.chat.id);
    const [act, docId] = String(cq.data || "").split(":");
    await tgCall(tg.token, "answerCallbackQuery", { callback_query_id: cq.id });
    const drv = await driverOf(chatId);
    if (!drv && act !== "amt") return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: "Siz shofyor sifatida ulanmagansiz. Administratordan havola so'rang." });
    if (act === "way") {
      const d = await updateDoc(docId, (x) => { if (x.status !== "delivered") x.status = "onway"; x.onwayAt = new Date().toISOString(); });
      return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: d ? `🚚 ${d.no}: «Yo'lda» deb belgilandi. Yetkazganingizdan keyin «📦 Yetkazib berdim» ni bosing.` : "Sotuv topilmadi." });
    }
    if (act === "done") {
      const b = await docBundle(docId);
      if (!b) return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: "Sotuv topilmadi." });
      if (b.d.status === "delivered") return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: `${b.d.no} allaqachon yopilgan.` });
      await setPriv("state:" + chatId, { step: "photo", docId, photos: [] });
      return tgCall(tg.token, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `📸 <b>${esc(b.d.no)}</b>: mijozga topshirilgan mebelning <b>suratini yuboring</b> (majburiy). Bir nechta surat yuborish mumkin.` });
    }
    const st = await priv("state:" + chatId);
    if (act === "photos_ok" && st.step === "photo" && st.photos?.length) {
      const b = await docBundle(st.docId);
      if (!b) return;
      if (b.rest <= 0) return finishDelivery(tg, chatId, st, 0);
      await setPriv("state:" + chatId, { ...st, step: "money", rest: b.rest });
      return tgCall(tg.token, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `💵 Mijozdan olinadigan: <b>${money(b.rest)}</b>. Qancha oldingiz?`,
        reply_markup: { inline_keyboard: [[{ text: `✅ ${money(b.rest)} oldim (to'liq)`, callback_data: "amt:full" }], [{ text: "✏️ Boshqa summa", callback_data: "amt:other" }], [{ text: "🚫 Pul olmadim", callback_data: "amt:none" }]] } });
    }
    if (act === "amt" && st.step === "money") {
      if (docId === "full") return finishDelivery(tg, chatId, st, st.rest);
      if (docId === "none") return finishDelivery(tg, chatId, st, 0);
      await setPriv("state:" + chatId, { ...st, step: "amount" });
      return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: "Olingan summani raqam bilan yozing (masalan: 1500000)." });
    }
    return;
  }
  if (!msg || chat?.type !== "private") return;
  const chatId = String(chat.id);
  const text = String(msg.text || "").trim();
  // Shofyorni ulash: /start d_<id>
  const m = text.match(/^\/start\s+d_([\w-]+)/);
  if (m) {
    const drivers = (await settings("drivers")) || [];
    const drv = drivers.find((x: any) => x.id === m[1]);
    if (!drv) return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: "Havola eskirgan. Administratordan yangisini so'rang." });
    await sb.from("driver_chats").upsert({ driver_id: drv.id, chat_id: chatId, tg_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" "), updated_at: new Date().toISOString() });
    return tgCall(tg.token, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `✅ Salom, <b>${esc(drv.name)}</b>! Siz shofyor sifatida ulandingiz. Yetkazish buyurtmalari shu yerga keladi.` });
  }
  const st = await priv("state:" + chatId);
  if (st.step === "photo") {
    const ph = msg.photo?.[msg.photo.length - 1]?.file_id || (msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : null);
    if (!ph) return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: "📸 Iltimos, surat yuboring — bu majburiy." });
    const photos = [...(st.photos || []), ph].slice(0, 10);
    await setPriv("state:" + chatId, { ...st, photos });
    if (photos.length === 1 || !msg.media_group_id) {
      return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: `Surat qabul qilindi (${photos.length}). Yana surat yuborishingiz mumkin yoki davom eting.`,
        reply_markup: { inline_keyboard: [[{ text: "➡️ Davom etish", callback_data: "photos_ok:" }]] } });
    }
    return;
  }
  if (st.step === "amount") {
    const n = Math.round(Number(text.replace(/[^\d]/g, "")));
    if (!n) return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: "Faqat raqam yozing, masalan: 1500000" });
    return finishDelivery(tg, chatId, st, n);
  }
  if (text.startsWith("/start")) {
    return tgCall(tg.token, "sendMessage", { chat_id: chatId, text: "Assalomu alaykum! Bu KAO Mebel boti." });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tg = (await settings("telegram")) || {};
  const secret = (await priv("webhook")).secret;
  // Telegram'dan kelgan xabar
  const tgSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (tgSecret) {
    if (!secret || tgSecret !== secret || !tg.token) return new Response("forbidden", { status: 403 });
    try { await onUpdate(tg, await req.json()); } catch (e) { console.error(e); }
    return new Response("ok");
  }
  // Dastur so'rovi — foydalanuvchi tekshiriladi
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await sb.auth.getUser(jwt);
  if (!who?.user) return out({ ok: false, error: "Kirish kerak" }, 401);
  const { data: prof } = await sb.from("profiles").select("role, active, perms").eq("id", who.user.id).maybeSingle();
  if (!prof?.active) return out({ ok: false, error: "Ruxsat yo'q" }, 403);
  if (!tg.token) return out({ ok: false, error: "Telegram bot sozlanmagan (Sozlamalar → Telegram)" }, 400);
  const body = await req.json().catch(() => ({}));

  if (body.action === "setup") {
    if (prof.role !== "admin") return out({ ok: false, error: "Faqat administrator" }, 403);
    const s = secret || crypto.randomUUID().replace(/-/g, "");
    await setPriv("webhook", { secret: s });
    const me = await tgCall(tg.token, "getMe", {});
    const r = await tgCall(tg.token, "setWebhook", { url: SELF_URL, secret_token: s, allowed_updates: ["message", "callback_query", "my_chat_member"], drop_pending_updates: false });
    if (!r.ok) return out({ ok: false, error: r.description }, 502);
    return out({ ok: true, botUsername: me.result?.username });
  }

  if (body.action === "send") {
    const b = await docBundle(String(body.docId || ""));
    if (!b) return out({ ok: false, error: "Sotuv topilmadi (avval saqlang)" }, 404);
    const { data: link } = await sb.from("driver_chats").select("chat_id").eq("driver_id", String(body.driverId || "")).maybeSingle();
    if (!link) return out({ ok: false, error: "Shofyor Telegramga ulanmagan: Sozlamalar → Shofyorlar dagi havolani unga yuboring" }, 400);
    const company = await settings("company");
    const r = await tgCall(tg.token, "sendMessage", { chat_id: link.chat_id, parse_mode: "HTML", text: orderText(b, company), reply_markup: orderKeyboard(b.d.id) });
    if (!r.ok) return out({ ok: false, error: r.description }, 502);
    await updateDoc(b.d.id, (d) => { d.driverId = body.driverId; d.driverSentTo = body.driverId; d.driverSentAt = new Date().toISOString(); });
    return out({ ok: true });
  }
  return out({ ok: false, error: "Noma'lum amal" }, 400);
});
