// Cloudflare Pages Function: POST /api/noest-order
// Sends one confirmed order from the admin dashboard to Noest Express,
// following the official "NOEST Public API" documentation v2.3.
//
// Set these in Cloudflare Pages → Settings → Variables and Secrets (type: Secret):
//   NOEST_API_TOKEN      "API TOKEN" from Noest → Paramètres API
//   NOEST_GUID           "GUID" from Noest → Paramètres API
//   ADMIN_KEY            any long password you choose; type the same one in
//                        the admin dashboard (Settings → مفتاح Noest)
// Optional:
//   NOEST_AUTO_VALIDATE  "1" = validate right away (visible to Noest logistics,
//                        can no longer be edited). Default: the order is
//                        created in Noest and you validate it there yourself.
//
// Noest's own error message is always passed back to the dashboard.

const NOEST = "https://app.noest-dz.com/api/public";

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8" },
});

// Noest station codes: "1A" not "01A" (see GET /api/public/desks)
export const stationCode = c => String(c || "").trim().toUpperCase().replace(/^0+(?=\d)/, "");

const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, " ").trim();

// Match the commune typed/picked on the site to Noest's exact commune name.
export function matchCommune(name, list) {
  const n = norm(name);
  const active = (list || []).filter(c => c && c.nom && c.is_active !== 0);
  if (!n || !active.length) return null;
  return active.find(c => norm(c.nom) === n)
      || active.find(c => norm(c.nom).replace(/ /g, "") === n.replace(/ /g, ""))
      || active.find(c => norm(c.nom).startsWith(n) || n.startsWith(norm(c.nom)))
      || active.find(c => norm(c.nom).includes(n) || n.includes(norm(c.nom)))
      || null;
}

export function buildNoestBody(o, env) {
  const isDesk = /stop\s*desk/i.test(o.deliv || "") || !!o.office;
  const items = Array.isArray(o.items) ? o.items : [];
  const produit = items.map(it => {
    const details = [it.color, it.size].filter(Boolean).join(" ").replace(/,/g, " ");
    return `${it.name || "Article"}${details ? ` ${details}` : ""} x${it.qty || 1}`.replace(/,/g, " ");
  }).join(" + ").slice(0, 250) || "Commande";
  const phones = String(o.phone || "").replace(/\D/g, "");
  const body = {
    user_guid: env.NOEST_GUID,
    reference: String(o.id || "").padEnd(5, "0"),          // min 5 characters
    client: `${o.name || ""} ${o.lastname || ""}`.replace(/\s+/g, " ").trim().slice(0, 255),
    phone: phones,
    adresse: ((isDesk && o.office && o.office.address) ? o.office.address : [o.commune, o.wilaya].filter(Boolean).join(", ")).slice(0, 255) || "-",
    wilaya_id: Number(o.wilayaCode) || 0,
    montant: Number(o.total) || 0,
    remarque: String(o.notes || "").slice(0, 255),
    produit,
    type_id: 1,                       // 1 = Delivery
    stop_desk: isDesk ? 1 : 0,        // 0 = Home, 1 = Stop desk
    stock: 0,
    shop_name: "Lilya Brand",
  };
  if (isDesk) body.station_code = stationCode(o.stationCode);
  else body.commune = o.commune || "";
  return body;
}

async function call(method, path, env, body) {
  const r = await fetch(`${NOEST}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${env.NOEST_API_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 800) }; }
  return { ok: r.ok, status: r.status, data };
}

function errorText(d, status) {
  if (!d) return `HTTP ${status}`;
  if (d.errors && typeof d.errors === "object") {
    return Object.values(d.errors).flat().join(" | ");
  }
  return d.message || d.error || d.raw || `HTTP ${status}`;
}

export async function onRequestPost({ request, env }) {
  if (!env.NOEST_API_TOKEN || !env.NOEST_GUID) {
    return json(500, { error: "NOEST_API_TOKEN / NOEST_GUID غير مضبوطين في إعدادات Cloudflare" });
  }
  const expected = String(env.ADMIN_KEY || "").trim();
  const given = String(request.headers.get("X-Admin-Key") || "").trim();
  if (!expected) {
    return json(500, { error: "ADMIN_KEY غير موجود في Cloudflare، أو لم تتم إعادة النشر بعد إضافته" });
  }
  if (!given) {
    return json(401, { error: "لم يُحفظ مفتاح Noest على هذا الجهاز وهذا الرابط (الإعدادات ← مفتاح Noest)" });
  }
  if (given !== expected) {
    return json(401, { error: `مفتاح Noest لا يطابق ADMIN_KEY في Cloudflare (المكتوب ${given.length} حرفًا، والمطلوب ${expected.length} حرفًا)` });
  }
  let o;
  try { o = await request.json(); } catch { return json(400, { error: "طلب غير صالح" }); }

  const body = buildNoestBody(o, env);
  if (body.phone.length < 9 || body.phone.length > 10) {
    return json(400, { error: `رقم الهاتف غير صالح لـ Noest (يجب 9 أو 10 أرقام): ${o.phone || ""}` });
  }
  if (body.stop_desk && !body.station_code) {
    return json(400, { error: "رمز مكتب Noest غير معروف لهذا المكتب (صفحة مكاتب Noest)" });
  }
  if (!body.stop_desk) {
    // use Noest's exact commune spelling
    const list = await call("GET", `/get/communes/${body.wilaya_id}`, env);
    if (list.ok && Array.isArray(list.data)) {
      const m = matchCommune(body.commune, list.data);
      if (!m) {
        return json(400, { error: `البلدية "${body.commune}" غير موجودة في Noest لهذه الولاية. البلديات المتاحة: ${list.data.filter(c=>c.is_active!==0).map(c => c.nom).slice(0, 60).join("، ")}` });
      }
      body.commune = m.nom;
    }
  }

  const created = await call("POST", "/create/order", env, body);
  const d = created.data || {};
  if (!created.ok || d.success === false || !d.tracking) {
    return json(502, { error: `Noest رفض الطلبية: ${errorText(d, created.status)}`, noest: d });
  }

  let validated = false, validation = null;
  if (env.NOEST_AUTO_VALIDATE === "1") {
    const v = await call("POST", "/valid/order", env, { user_guid: env.NOEST_GUID, tracking: d.tracking });
    validation = v.data;
    validated = v.ok && !!(v.data && v.data.success);
  }
  return json(200, { tracking: d.tracking, validated, noest: d, validation });
}

export async function onRequest() {
  return json(405, { error: "POST only" });
}
