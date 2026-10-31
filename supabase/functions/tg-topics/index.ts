// Telegram guruh temalarini yangilash (nomi va ikonkasi). Faqat bir martalik kalit (ops_nonce) bilan ishlaydi:
// kalitni faqat baza egasi qo'sha oladi, ishlatilgach o'chiriladi.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const { data: n } = await sb.from("ops_nonce").delete().eq("id", String(body.nonce || "")).gte("created_at", new Date(Date.now() - 600e3).toISOString()).select("id");
  if (!n?.length) return Response.json({ ok: false, error: "ruxsat yo'q" }, { status: 403 });
  const { data: row } = await sb.from("settings").select("data").eq("id", "telegram").single();
  const tg = row?.data?.value || {};
  if (!tg.token || !tg.chatId) return Response.json({ ok: false, error: "telegram sozlanmagan" });
  const call = async (method: string, payload: any) => {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return await r.json().catch(() => ({ ok: false, description: String(r.status) }));
  };
  const icons = await call("getForumTopicIconStickers", {});
  const map = new Map<string, string>((icons.result || []).map((s: any) => [String(s.emoji || "").replace(/️/g, ""), s.custom_emoji_id]));
  const results: any[] = [];
  for (const t of body.topics || []) {
    const icon = [...(t.prefs || []), "🏠", "📁"].map((e: string) => map.get(e.replace(/️/g, ""))).find(Boolean);
    const out = await call("editForumTopic", Object.assign({ chat_id: tg.chatId, message_thread_id: t.thread, name: t.title }, icon ? { icon_custom_emoji_id: icon } : {}));
    results.push({ title: t.title, ok: out.ok, error: out.ok ? undefined : out.description, icon: !!icon });
    await new Promise((r) => setTimeout(r, 700));
  }
  return Response.json({ ok: true, available_icons: [...map.keys()].join(" "), results });
});
