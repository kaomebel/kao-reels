// To'lov cheklari (karta, terminal, perechisleniye) — server xotirasida emas, Telegramda saqlanadi.
// POST (multipart: photo[], caption) — suratlarni bot orqali administratorning shaxsiy chatiga
//   (yoki sozlamalarda tanlangan guruh temasiga) yuboradi va Telegram fayl ID larini qaytaradi.
// GET ?file_id=... — chek suratini Telegramdan olib beradi (dasturda ko'rish uchun).
// Faqat dasturning faol foydalanuvchilari ishlata oladi; bot tokeni ularga ko'rinmaydi.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await sb.auth.getUser(jwt);
  if (!who?.user) return json({ ok: false, error: "Kirish kerak" }, 401);
  const { data: prof } = await sb.from("profiles").select("name, active").eq("id", who.user.id).maybeSingle();
  if (!prof?.active) return json({ ok: false, error: "Ruxsat yo'q" }, 403);
  const { data: row } = await sb.from("settings").select("data").eq("id", "telegram").maybeSingle();
  const tg = row?.data?.value || {};
  if (!tg.token) return json({ ok: false, error: "Telegram bot sozlanmagan (Sozlamalar → Telegram)" }, 400);
  const api = (m: string) => `https://api.telegram.org/bot${tg.token}/${m}`;

  if (req.method === "GET") {
    const fileId = new URL(req.url).searchParams.get("file_id") || "";
    const info = await (await fetch(api("getFile") + "?file_id=" + encodeURIComponent(fileId))).json();
    if (!info.ok) return json({ ok: false, error: info.description || "Topilmadi" }, 404);
    const img = await fetch(`https://api.telegram.org/file/bot${tg.token}/${info.result.file_path}`);
    return new Response(img.body, { headers: { ...CORS, "Content-Type": img.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=86400" } });
  }

  const toGroup = tg.receiptsTo === "group" && tg.chatId;
  const chatId = toGroup ? tg.chatId : tg.backupChatId;
  if (!chatId) return json({ ok: false, error: "Cheklar uchun Telegram chat tanlanmagan: Sozlamalar → Zaxira nusxa → «Mening Telegramimni aniqlash»" }, 400);
  const form = await req.formData();
  const photos = form.getAll("photo").filter((f) => f instanceof File) as File[];
  if (!photos.length) return json({ ok: false, error: "Surat yo'q" }, 400);
  const caption = String(form.get("caption") || "").slice(0, 1000) + `\n👤 ${prof.name}`;
  const base: Record<string, string> = { chat_id: String(chatId) };
  if (toGroup && tg.receiptsThread) base.message_thread_id = String(tg.receiptsThread);
  const fd = new FormData();
  Object.entries(base).forEach(([k, v]) => fd.append(k, v));
  let res;
  if (photos.length === 1) {
    fd.append("photo", photos[0], "chek.jpg");
    fd.append("caption", caption);
    res = await (await fetch(api("sendPhoto"), { method: "POST", body: fd })).json();
  } else {
    fd.append("media", JSON.stringify(photos.slice(0, 10).map((_, i) => Object.assign({ type: "photo", media: `attach://p${i}` }, i === 0 ? { caption } : {}))));
    photos.slice(0, 10).forEach((f, i) => fd.append(`p${i}`, f, `chek${i}.jpg`));
    res = await (await fetch(api("sendMediaGroup"), { method: "POST", body: fd })).json();
  }
  if (!res.ok) return json({ ok: false, error: res.description || "Telegram xatosi" }, 502);
  const msgs = Array.isArray(res.result) ? res.result : [res.result];
  const receipts = msgs.map((m: any) => ({ fileId: m.photo?.[m.photo.length - 1]?.file_id, msgId: m.message_id, chat: String(chatId) })).filter((r: any) => r.fileId);
  return json({ ok: true, receipts });
});
