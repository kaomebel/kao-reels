// Har kungi server zaxirasi: telefonlarga bog'liq emas, har kecha serverning o'zi ishga tushiradi (pg_cron).
// 1) Barcha ma'lumotlar dasturdagi «Zaxiradan tiklash» qabul qiladigan formatda JSON faylga yig'iladi
// 2) Fayl Supabase Storage'dagi yopiq «backups» xotirasiga yoziladi (oxirgi 90 kun saqlanadi)
// 3) Bot tokeni va administrator Telegram ID'si kiritilgan bo'lsa, fayl Telegramga ham yuboriladi
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const KEEP_DAYS = 90;
const SETTINGS_KEYS = ["categories", "categoryTypes", "materials", "colors", "customerTypes", "featureSets", "categoryIcons", "expenseCats", "regions", "currency", "company", "telegram", "legacyUsers"];

Deno.serve(async () => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const all = async (table: string, cols = "id,data") => {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select(cols).order("id").range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) return out;
    }
  };
  // Tashqaridan qayta-qayta chaqirilsa ham soatiga bir martadan ko'p ishlamaydi
  const { data: recent } = await sb.from("backup_log").select("at").eq("ok", true).gte("at", new Date(Date.now() - 3600e3).toISOString()).limit(1);
  if (recent?.length) return Response.json({ ok: true, skipped: "oxirgi soat ichida zaxira olingan" });
  try {
    const [warehouses, counterparties, products, docs, payments, costs, settings, counters, profiles] = await Promise.all([
      all("warehouses"), all("counterparties"), all("products"), all("docs"), all("payments"),
      all("product_costs"), all("settings"), all("counters", "id,value"), all("profiles", "id,name,login,role,perms"),
    ]);
    const cost = new Map(costs.map((r) => [r.id, r.data.buyPrice]));
    const backup: any = {
      warehouses: warehouses.map((r) => r.data),
      counterparties: counterparties.map((r) => r.data),
      products: products.map((r) => (cost.has(r.id) ? { ...r.data, buyPrice: cost.get(r.id) } : r.data)),
      docs: docs.map((r) => r.data),
      payments: payments.map((r) => r.data),
      seq: Object.fromEntries(counters.map((r) => [r.id, r.value])),
      users: profiles.map((u) => ({ ...u, login: String(u.login).replace(/@kao\.local$/, "") })),
    };
    for (const r of settings) if (SETTINGS_KEYS.includes(r.id)) backup[r.id] = r.data?.value;
    const now = new Date();
    backup.exportedAt = now.toISOString();
    backup.source = "server";
    const json = JSON.stringify(backup);
    const name = `biznes-tizim-zaxira-${now.toISOString().slice(0, 10)}.json`;

    // 1) Yopiq xotiraga
    const up = await sb.storage.from("backups").upload(`daily/${name}`, new Blob([json], { type: "application/json" }), { upsert: true, contentType: "application/json" });
    if (up.error) throw new Error("storage: " + up.error.message);
    const { data: files } = await sb.storage.from("backups").list("daily", { limit: 1000 });
    const old = (files || []).map((f) => f.name).sort().slice(0, -KEEP_DAYS);
    if (old.length) await sb.storage.from("backups").remove(old.map((n) => `daily/${n}`));

    // 2) Telegramga (agar sozlangan bo'lsa)
    const tg = backup.telegram || {};
    let telegram = "sozlanmagan";
    if (tg.token && tg.backupChatId) {
      const fd = new FormData();
      fd.append("chat_id", String(tg.backupChatId));
      fd.append("document", new Blob([json], { type: "application/json" }), name);
      fd.append("caption", `📦 Biznes Tizim — server zaxirasi\n${now.toISOString().slice(0, 16).replace("T", " ")} (UTC)\nMahsulot: ${backup.products.length} · Hujjat: ${backup.docs.length} · To'lov: ${backup.payments.length}\n\nTiklash: Sozlamalar → Zaxira nusxa → Zaxiradan tiklash`);
      const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendDocument`, { method: "POST", body: fd });
      const out = await res.json().catch(() => ({}));
      telegram = out.ok ? "yuborildi" : "xato: " + (out.description || res.status);
    }
    await sb.from("backup_log").insert({ file: name, bytes: json.length, telegram, ok: true });
    return Response.json({ ok: true, file: name, bytes: json.length, telegram });
  } catch (e) {
    await sb.from("backup_log").insert({ file: null, bytes: 0, telegram: null, ok: false, error: String((e as Error).message || e) });
    return Response.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
});
