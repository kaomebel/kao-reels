// Mahsulot rasmidan tavsiya: qanday mebel (kategoriya, tur), material, rang va xususiyatlar.
// POST JSON { image: <base64 JPEG>, options: { categories: {kat: [turlar]}, materials: [...],
//   materialColors: {material: [ranglar]}, colors: [...], featureSets: [{applies: [...], fields: [{name, options}]}] } }
// Javob: { ok, suggestion: { name, category, type, materials, colors, attrs: [{field, value}], description } }
// Faqat dasturning faol foydalanuvchilari; Claude kaliti — ANTHROPIC_API_KEY (Edge Function secrets).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const AI_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const ai = AI_KEY ? new Anthropic({ apiKey: AI_KEY }) : null;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Qisqa mahsulot nomi o'zbekcha (masalan: «Ofis kreslosi, setkali»)" },
    category: { type: "string" },
    type: { type: "string" },
    materials: { type: "array", items: { type: "string" } },
    colors: { type: "array", items: { type: "string" } },
    attrs: {
      type: "array",
      items: { type: "object", properties: { field: { type: "string" }, value: { type: "string" } }, required: ["field", "value"], additionalProperties: false },
    },
    description: { type: "string", description: "1-2 gapli tavsif o'zbekcha" },
  },
  required: ["name", "category", "type", "materials", "colors", "attrs", "description"],
  additionalProperties: false,
};

// Har bir foydalanuvchiga soatiga ko'pi bilan shuncha so'rov (xarajat cheklovi)
const LIMIT_PER_HOUR = 60;
const used = new Map<string, number[]>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST kerak" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await sb.auth.getUser(jwt);
  if (!who?.user) return json({ ok: false, error: "Kirish kerak" }, 401);
  const { data: prof } = await sb.from("profiles").select("active").eq("id", who.user.id).maybeSingle();
  if (!prof?.active) return json({ ok: false, error: "Ruxsat yo'q" }, 403);
  if (!ai) return json({ ok: false, error: "AI sozlanmagan: Supabase → Edge Functions → Secrets ga ANTHROPIC_API_KEY qo'shing" }, 400);

  const now = Date.now();
  const recent = (used.get(who.user.id) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= LIMIT_PER_HOUR) return json({ ok: false, error: "Juda ko'p so'rov — birozdan keyin urinib ko'ring" }, 429);
  recent.push(now);
  used.set(who.user.id, recent);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Noto'g'ri so'rov" }, 400); }
  const image = String(body?.image || "").replace(/^data:image\/\w+;base64,/, "");
  if (!image || image.length > 6_000_000) return json({ ok: false, error: "Rasm yo'q yoki juda katta" }, 400);
  const o = body?.options || {};

  const lists = [
    `KATEGORIYALAR VA TURLAR (kategoriya: turlar):\n${Object.entries(o.categories || {}).map(([c, t]) => `- ${c}: ${(t as string[]).join(", ")}`).join("\n")}`,
    `MATERIALLAR: ${(o.materials || []).join(", ")}`,
    `MATERIAL RANGLARI:\n${Object.entries(o.materialColors || {}).map(([m, c]) => `- ${m}: ${(c as string[]).join(", ")}`).join("\n")}`,
    `UMUMIY RANGLAR: ${(o.colors || []).join(", ")}`,
    (o.featureSets || []).length
      ? `TURGA XOS MAYDONLAR (shu turlarda material/rang shu maydonlar orqali tanlanadi):\n${(o.featureSets || []).map((f: any) =>
        `- ${(f.applies || []).join(" / ")}: ${(f.fields || []).map((x: any) => `${x.name} [${(x.options || []).join(", ")}]`).join("; ")}${f.colors?.length ? `; ranglar [${f.colors.join(", ")}]` : ""}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");

  try {
    const res: any = await ai.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{
        type: "text",
        text: "Siz mebel do'koni dasturida mahsulot rasmini ko'rib, kartochkani to'ldirishga tavsiya beradigan yordamchisiz. " +
          "Rasmdagi asosiy mebelni aniqlang. Kategoriya, tur, material va ranglarni IMKON QADAR berilgan ro'yxatlardan aynan o'sha yozilishda tanlang. " +
          "Mos keladigani bo'lmasa — qisqa o'zbekcha (lotin) nom taklif qiling. Bilmasangiz bo'sh qoldiring (\"\" yoki []). " +
          "Mebel turi «Turga xos maydonlar» ro'yxatidagi turlardan biri bo'lsa (masalan, kreslo yoki stul) — materialni attrs da o'sha maydon nomi bilan bering " +
          "(masalan: field «Qoplama materiali», value «Setka (to'r)»), materials ni esa bo'sh qoldiring. " +
          "Ranglar — rasmda ko'ringan asosiy ranglar, 1-3 ta. O'lcham va narxni taxmin qilmang.",
      }],
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: lists + "\n\nShu rasmdagi mebel uchun kartochka tavsiyasini bering." },
        ],
      }],
    } as any);
    if (res.stop_reason === "refusal") return json({ ok: false, error: "AI bu rasmni tahlil qilmadi" }, 422);
    const block = (res.content || []).find((b: any) => b.type === "text");
    if (!block) return json({ ok: false, error: "AI javob bermadi" }, 502);
    return json({ ok: true, suggestion: JSON.parse(block.text) });
  } catch (e) {
    console.error("AI xatosi:", (e as Error).message);
    return json({ ok: false, error: "AI xatosi: " + (e as Error).message }, 502);
  }
});
