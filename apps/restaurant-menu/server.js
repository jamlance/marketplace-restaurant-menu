import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import { mountAppCore, inkressApi, createInkressOrder, getInkressOrder, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { putObject, storageConfigured, decodeDataUrl, isAllowedImage } from "@inkress/apps-core/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[restaurant-menu] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("restaurant_menu", `
  CREATE TABLE IF NOT EXISTS profiles (
    merchant_id BIGINT PRIMARY KEY, name TEXT, logo TEXT, tagline TEXT, currency TEXT NOT NULL DEFAULT 'JMD',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS accent TEXT NOT NULL DEFAULT '#c2410c';
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pay_enabled BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS service_charge_pct NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tipping_enabled BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tip_presets JSONB NOT NULL DEFAULT '[10,15,20]';
  CREATE TABLE IF NOT EXISTS menus (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
    start_min INTEGER, end_min INTEGER, sort INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS items (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Mains', name TEXT NOT NULL, description TEXT,
    price NUMERIC NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'JMD',
    available BOOLEAN NOT NULL DEFAULT true, sort INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE items ADD COLUMN IF NOT EXISTS image_url TEXT;
  ALTER TABLE items ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE items ADD COLUMN IF NOT EXISTS modifiers JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE items ADD COLUMN IF NOT EXISTS menu_id BIGINT;
  ALTER TABLE items ADD COLUMN IF NOT EXISTS product_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_rm_items ON items (merchant_id, category, sort, id);
  CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, ref TEXT NOT NULL, table_no TEXT,
    customer_name TEXT, note TEXT, lines JSONB NOT NULL DEFAULT '[]',
    subtotal NUMERIC NOT NULL DEFAULT 0, service_charge NUMERIC NOT NULL DEFAULT 0, tip NUMERIC NOT NULL DEFAULT 0,
    total NUMERIC NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'JMD',
    state TEXT NOT NULL DEFAULT 'new', pay_mode TEXT NOT NULL DEFAULT 'counter', paid BOOLEAN NOT NULL DEFAULT false,
    inkress_order_id TEXT, payment_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_rm_orders ON orders (merchant_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rm_order_ref ON orders (merchant_id, ref);
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("restaurant_menu", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
const PUBLIC_BASE_S = () => process.env.PUBLIC_BASE_URL || "";
const arr = (v) => (Array.isArray(v) ? v : []);
const KITCHEN_FLOW = ["new", "preparing", "ready", "served"];

const serializeItem = (i) => ({ id: i.id, category: i.category, name: i.name, description: i.description, price: Number(i.price), currency: i.currency, available: i.available, sort: i.sort, image_url: i.image_url, tags: arr(i.tags), modifiers: arr(i.modifiers), menu_id: i.menu_id != null ? Number(i.menu_id) : null, product_id: i.product_id });
const serializeOrder = (o) => ({ id: o.id, ref: o.ref, table_no: o.table_no, customer_name: o.customer_name, note: o.note, lines: arr(o.lines), subtotal: Number(o.subtotal), service_charge: Number(o.service_charge), tip: Number(o.tip), total: Number(o.total), currency: o.currency, state: o.state, pay_mode: o.pay_mode, paid: o.paid, payment_url: o.payment_url, created_at: o.created_at });
const serializeProfile = (p) => ({ name: p?.name || null, logo: p?.logo || null, tagline: p?.tagline || null, accent: p?.accent || "#c2410c", currency: p?.currency || "JMD", pay_enabled: p?.pay_enabled === true, service_charge_pct: Number(p?.service_charge_pct || 0), tipping_enabled: p?.tipping_enabled !== false, tip_presets: arr(p?.tip_presets).length ? arr(p.tip_presets) : [10, 15, 20] });
const cleanModifiers = (v) => arr(v).slice(0, 12).map((g) => ({ name: String(g?.name || "Option").slice(0, 60), required: !!g?.required, multi: !!g?.multi, options: arr(g?.options).slice(0, 24).map((o) => ({ name: String(o?.name || "").slice(0, 60), price: round2(o?.price) })).filter((o) => o.name) })).filter((g) => g.options.length);
const cleanTags = (v) => arr(v).slice(0, 8).map((t) => String(t).slice(0, 24)).filter(Boolean);

async function saveProfile(req) {
  const m = req.session.data?.merchant || {};
  await db.run(`INSERT INTO profiles (merchant_id, name, logo, currency) VALUES ($1,$2,$3,$4)
    ON CONFLICT (merchant_id) DO UPDATE SET name=COALESCE(profiles.name, EXCLUDED.name), logo=COALESCE(EXCLUDED.logo, profiles.logo), currency=EXCLUDED.currency, updated_at=now()`,
    [req.session.merchantId, m.name || null, m.logo || m.logo_url || null, m.currency_code || "JMD"]);
}
async function getProfile(mid) { return (await db.one(`SELECT * FROM profiles WHERE merchant_id=$1`, [mid]).catch(() => null)) || { merchant_id: mid }; }

app.get("/api/menu", core.requireSession, async (req, res) => {
  await saveProfile(req).catch(() => {});
  const mid = req.session.merchantId;
  const profile = await getProfile(mid);
  const rows = await db.q(`SELECT * FROM items WHERE merchant_id=$1 ORDER BY category, sort, id`, [mid]);
  const menus = await db.q(`SELECT * FROM menus WHERE merchant_id=$1 ORDER BY sort, id`, [mid]);
  const items = rows.map(serializeItem);
  const categories = [...new Set(items.map((i) => i.category))];
  res.json({
    items, categories, menus: menus.map((mn) => ({ id: mn.id, name: mn.name, active: mn.active, start_min: mn.start_min, end_min: mn.end_min, sort: mn.sort })),
    profile: serializeProfile(profile),
    public_url: `${PUBLIC_BASE(req)}/m/${mid}`,
    storage: storageConfigured(), products: (req.session.scope || []).includes("products:read"), webhook_realtime: Boolean(WEBHOOK_SECRET),
    can_pay: (req.session.scope || []).includes("orders:write"),
    stats: { items: items.length, available: items.filter((i) => i.available).length, categories: categories.length },
  });
});

app.patch("/api/settings", core.requireSession, async (req, res) => {
  const b = req.body || {}; const mid = req.session.merchantId;
  await saveProfile(req).catch(() => {});
  const p = await getProfile(mid);
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(b.accent || "")) ? b.accent : p.accent || "#c2410c";
  const presets = arr(b.tip_presets).map((n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))).filter((n, i, a) => a.indexOf(n) === i).slice(0, 5);
  const u = await db.one(`UPDATE profiles SET name=$1, tagline=$2, accent=$3, pay_enabled=$4, service_charge_pct=$5, tipping_enabled=$6, tip_presets=$7, updated_at=now() WHERE merchant_id=$8 RETURNING *`,
    [b.name !== undefined ? (String(b.name).trim() || null) : p.name, b.tagline !== undefined ? (String(b.tagline).trim() || null) : p.tagline, accent,
      b.pay_enabled != null ? !!b.pay_enabled : p.pay_enabled, b.service_charge_pct != null ? Math.max(0, Math.min(100, round2(b.service_charge_pct))) : p.service_charge_pct,
      b.tipping_enabled != null ? !!b.tipping_enabled : p.tipping_enabled, JSON.stringify(presets.length ? presets : arr(p.tip_presets)), mid]);
  res.json({ profile: serializeProfile(u) });
});

/* ---- Menus (multiple menus + optional time windows) ---- */
app.post("/api/menus", core.requireSession, async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || "").trim()) return res.status(400).json({ error: "no_name", message: "Menu needs a name." });
  const s = await db.one(`SELECT COALESCE(MAX(sort),0)+1 AS s FROM menus WHERE merchant_id=$1`, [req.session.merchantId]);
  const row = await db.one(`INSERT INTO menus (merchant_id, name, active, start_min, end_min, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.session.merchantId, b.name.trim(), b.active !== false, b.start_min != null ? Number(b.start_min) : null, b.end_min != null ? Number(b.end_min) : null, s.s]);
  res.status(201).json({ menu: { id: row.id, name: row.name, active: row.active, start_min: row.start_min, end_min: row.end_min, sort: row.sort } });
});
app.patch("/api/menus/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const mn = await db.one(`SELECT * FROM menus WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!mn) return res.status(404).json({ error: "not_found" });
  const u = await db.one(`UPDATE menus SET name=$1, active=$2, start_min=$3, end_min=$4 WHERE id=$5 RETURNING *`,
    [b.name ?? mn.name, b.active != null ? !!b.active : mn.active, b.start_min !== undefined ? (b.start_min != null ? Number(b.start_min) : null) : mn.start_min, b.end_min !== undefined ? (b.end_min != null ? Number(b.end_min) : null) : mn.end_min, mn.id]);
  res.json({ menu: { id: u.id, name: u.name, active: u.active, start_min: u.start_min, end_min: u.end_min, sort: u.sort } });
});
app.delete("/api/menus/:id", core.requireSession, async (req, res) => {
  await db.run(`UPDATE items SET menu_id=NULL WHERE menu_id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  await db.run(`DELETE FROM menus WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

/* ---- Items ---- */
app.post("/api/items", core.requireSession, async (req, res) => {
  const b = req.body || {}; const m = req.session.data?.merchant || {};
  const name = String(b.name || "").trim();
  if (!name) return res.status(400).json({ error: "no_name", message: "Item needs a name." });
  const cat = String(b.category || "Mains").trim() || "Mains";
  const sortRow = await db.one(`SELECT COALESCE(MAX(sort),0)+1 AS s FROM items WHERE merchant_id=$1 AND category=$2`, [req.session.merchantId, cat]);
  const row = await db.one(`INSERT INTO items (merchant_id, category, name, description, price, currency, available, sort, image_url, tags, modifiers, menu_id, product_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.session.merchantId, cat, name, String(b.description || "").trim() || null, round2(b.price), m.currency_code || "JMD", b.available !== false, sortRow.s,
      cleanUrl(b.image_url), JSON.stringify(cleanTags(b.tags)), JSON.stringify(cleanModifiers(b.modifiers)), b.menu_id != null ? Number(b.menu_id) : null, b.product_id != null ? String(b.product_id) : null]);
  res.status(201).json({ item: serializeItem(row) });
});
app.patch("/api/items/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const it = await db.one(`SELECT * FROM items WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!it) return res.status(404).json({ error: "not_found" });
  const u = await db.one(`UPDATE items SET category=$1, name=$2, description=$3, price=$4, available=$5, image_url=$6, tags=$7, modifiers=$8, menu_id=$9 WHERE id=$10 RETURNING *`,
    [String(b.category ?? it.category).trim() || it.category, String(b.name ?? it.name).trim() || it.name, b.description !== undefined ? (String(b.description).trim() || null) : it.description,
      b.price != null ? round2(b.price) : it.price, b.available != null ? !!b.available : it.available, b.image_url !== undefined ? cleanUrl(b.image_url) : it.image_url,
      b.tags !== undefined ? JSON.stringify(cleanTags(b.tags)) : JSON.stringify(arr(it.tags)), b.modifiers !== undefined ? JSON.stringify(cleanModifiers(b.modifiers)) : JSON.stringify(arr(it.modifiers)),
      b.menu_id !== undefined ? (b.menu_id != null ? Number(b.menu_id) : null) : it.menu_id, it.id]);
  res.json({ item: serializeItem(u) });
});
app.post("/api/items/reorder", core.requireSession, async (req, res) => {
  const ids = arr(req.body?.ids).map(Number).filter(Boolean);
  for (let i = 0; i < ids.length; i++) await db.run(`UPDATE items SET sort=$1 WHERE id=$2 AND merchant_id=$3`, [i, ids[i], req.session.merchantId]);
  res.json({ ok: true });
});
app.delete("/api/items/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM items WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

/* ---- Image upload (S3) + catalog import ---- */
app.post("/api/upload", core.requireSession, async (req, res) => {
  if (!storageConfigured()) return res.status(503).json({ error: "storage_off", message: "Image hosting isn't configured — paste an image URL instead." });
  const decoded = decodeDataUrl(req.body?.data);
  if (!decoded || !isAllowedImage(decoded.contentType)) return res.status(400).json({ error: "bad_image", message: "Upload a JPG, PNG, WEBP or GIF." });
  try { const { url } = await putObject({ prefix: `restaurant-menu/${req.session.merchantId}`, body: decoded.body, contentType: decoded.contentType }); res.json({ url }); }
  catch (err) { res.status(502).json({ error: "upload_failed", message: err?.message }); }
});
app.get("/api/products", core.requireSession, async (req, res) => {
  if (!(req.session.scope || []).includes("products:read")) return res.json({ products: [], unavailable: true });
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `products?limit=40&order=id desc${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const products = (r?.result?.entries || []).map((p) => { const cur = p.currency || {}; const raw = Number(p.price ?? 0); return { id: p.id, title: p.title || p.name || `Product ${p.id}`, description: p.description || null, price: cur.is_float === true ? raw / 100 : raw, image: p.image_url || p.image || null, currency: cur.code || req.session.data?.merchant?.currency_code || "JMD" }; });
    res.json({ products });
  } catch (err) { res.status(502).json({ error: "products_failed", message: err?.message }); }
});
app.post("/api/import-products", core.requireSession, async (req, res) => {
  const m = req.session.data?.merchant || {}; const cat = String(req.body?.category || "Mains").trim() || "Mains";
  const picks = arr(req.body?.products).slice(0, 100);
  let n = 0;
  for (const p of picks) {
    if (!p?.title) continue;
    const s = await db.one(`SELECT COALESCE(MAX(sort),0)+1 AS s FROM items WHERE merchant_id=$1 AND category=$2`, [req.session.merchantId, cat]);
    await db.run(`INSERT INTO items (merchant_id, category, name, description, price, currency, available, sort, image_url, product_id) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`,
      [req.session.merchantId, cat, String(p.title).slice(0, 120), p.description ? String(p.description).slice(0, 400) : null, round2(p.price), m.currency_code || "JMD", s.s, cleanUrl(p.image), p.id != null ? String(p.id) : null]); n++;
  }
  res.json({ imported: n });
});

/* ---- QR + printable table tents ---- */
app.get("/api/qr", core.requireSession, async (req, res) => {
  const table = String(req.query.table || "").trim();
  const url = `${PUBLIC_BASE(req)}/m/${req.session.merchantId}${table ? `?table=${encodeURIComponent(table)}` : ""}`;
  try { res.json({ url, data_url: await QRCode.toDataURL(url, { margin: 1, width: 320 }) }); }
  catch (err) { res.status(500).json({ error: "qr_failed", message: err?.message }); }
});
app.get("/api/table-tents", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const profile = await getProfile(mid);
  const spec = String(req.query.tables || "1-12");
  const tables = parseTables(spec);
  const base = `${PUBLIC_BASE(req)}/m/${mid}`;
  const cards = [];
  for (const t of tables) {
    const url = `${base}?table=${encodeURIComponent(t)}`;
    const data = await QRCode.toDataURL(url, { margin: 1, width: 360 }).catch(() => "");
    cards.push(`<div class="tent"><div class="tent-name">${esc(profile.name || "Scan to order")}</div><img src="${data}" alt="QR"><div class="tent-table">Table ${esc(String(t))}</div><div class="tent-hint">Scan to view the menu & order</div></div>`);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Table tents</title><style>
    @page{size:A4;margin:12mm}body{font-family:system-ui,sans-serif;margin:0;background:#fff;color:#1a1a1a}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10mm}
    .tent{border:1px dashed #bbb;border-radius:10px;padding:14mm 6mm;text-align:center;break-inside:avoid;page-break-inside:avoid}
    .tent-name{font-weight:700;font-size:15pt;margin-bottom:6mm}.tent img{width:46mm;height:46mm}
    .tent-table{font-size:22pt;font-weight:800;margin-top:6mm;color:${esc(profile.accent || "#c2410c")}}
    .tent-hint{color:#777;font-size:9pt;margin-top:2mm}
    .bar{padding:8px 14px;background:#f4f4f5;font-size:13px;text-align:center;color:#555}@media print{.bar{display:none}}
    </style></head><body><div class="bar">Print this page (Ctrl/Cmd-P) — one QR card per table. Fold along the dashed line.</div><div class="grid">${cards.join("")}</div></body></html>`);
});

/* ---- Kitchen / live orders ---- */
app.get("/api/orders", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  if (req.query.refresh === "1") {
    const awaiting = await db.q(`SELECT * FROM orders WHERE merchant_id=$1 AND pay_mode='inkress' AND paid=false AND inkress_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 25`, [mid]);
    for (const o of awaiting) { try { const ink = await getInkressOrder(core.cfg, req.session.accessToken, o.inkress_order_id); if (ink && isPaidStatus(ink)) await db.run(`UPDATE orders SET paid=true WHERE id=$1`, [o.id]); } catch { /* */ } }
  }
  const includeDone = req.query.all === "1";
  const rows = await db.q(`SELECT * FROM orders WHERE merchant_id=$1 ${includeDone ? "" : "AND state <> 'served' AND state <> 'cancelled'"} ORDER BY created_at DESC LIMIT 200`, [mid]);
  const today = await db.one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0) AS rev FROM orders WHERE merchant_id=$1 AND created_at::date = now()::date AND state <> 'cancelled'`, [mid]);
  res.json({ orders: rows.map(serializeOrder), stats: { today_orders: today?.n || 0, today_revenue: Number(today?.rev || 0) } });
});
app.patch("/api/orders/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const o = await db.one(`SELECT * FROM orders WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!o) return res.status(404).json({ error: "not_found" });
  let state = o.state, paid = o.paid;
  if (b.state && (KITCHEN_FLOW.includes(b.state) || b.state === "cancelled")) state = b.state;
  if (b.advance) { const i = KITCHEN_FLOW.indexOf(o.state); state = KITCHEN_FLOW[Math.min(KITCHEN_FLOW.length - 1, i + 1)] || o.state; }
  if (b.paid != null) paid = !!b.paid;
  const u = await db.one(`UPDATE orders SET state=$1, paid=$2 WHERE id=$3 RETURNING *`, [state, paid, o.id]);
  res.json({ order: serializeOrder(u) });
});

/* ---- Webhook self-registration / status ---- */
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try { await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) }); await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid }; }
    catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [mid, url]); sub = { merchant_id: mid }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), storage: storageConfigured() });
});

/* ---- Public diner ordering ---- */
app.get("/m/:merchantId", async (req, res) => {
  const mid = Number(req.params.merchantId);
  const profile = await getProfile(mid);
  const menus = await db.q(`SELECT * FROM menus WHERE merchant_id=$1 ORDER BY sort, id`, [mid]).catch(() => []);
  const activeMenu = pickActiveMenu(menus);
  const rows = await db.q(`SELECT * FROM items WHERE merchant_id=$1 AND available=true ${activeMenu ? "AND (menu_id=$2 OR menu_id IS NULL)" : ""} ORDER BY category, sort, id`, activeMenu ? [mid, activeMenu.id] : [mid]).catch(() => []);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dinerPage(mid, serializeProfile(profile), rows.map(serializeItem), String(req.query.table || "")));
});
app.post("/api/public/order/:merchantId", express.json({ limit: "256kb" }), async (req, res) => {
  const mid = Number(req.params.merchantId);
  const profile = await getProfile(mid);
  const prof = serializeProfile(profile);
  const cart = arr(req.body?.lines);
  if (!cart.length) return res.status(400).json({ error: "empty", message: "Your order is empty." });
  const ids = [...new Set(cart.map((l) => Number(l.item_id)).filter(Boolean))];
  const items = ids.length ? await db.q(`SELECT * FROM items WHERE merchant_id=$1 AND id = ANY($2::bigint[]) AND available=true`, [mid, ids]) : [];
  const byId = new Map(items.map((i) => [Number(i.id), i]));
  const lines = []; let subtotal = 0;
  for (const l of cart) {
    const it = byId.get(Number(l.item_id)); if (!it) continue;
    const qty = Math.max(1, Math.min(50, Number(l.qty) || 1));
    let unit = Number(it.price); const chosen = [];
    for (const g of arr(it.modifiers)) {
      const picks = arr(l.options).filter((o) => o.group === g.name);
      for (const pk of picks) { const opt = arr(g.options).find((o) => o.name === pk.option); if (opt) { unit += Number(opt.price) || 0; chosen.push({ group: g.name, option: opt.name, price: Number(opt.price) || 0 }); } }
    }
    unit = round2(unit); const lineTotal = round2(unit * qty); subtotal += lineTotal;
    lines.push({ item_id: it.id, name: it.name, qty, unit, line_total: lineTotal, options: chosen });
  }
  if (!lines.length) return res.status(400).json({ error: "empty", message: "Nothing orderable in your cart." });
  subtotal = round2(subtotal);
  const payOn = prof.pay_enabled;
  const service = payOn && prof.service_charge_pct > 0 ? round2(subtotal * prof.service_charge_pct / 100) : 0;
  const tip = payOn && prof.tipping_enabled ? Math.max(0, round2(req.body?.tip)) : 0;
  const total = round2(subtotal + service + tip);
  const ref = `rm-${mid}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const tableNo = String(req.body?.table || "").slice(0, 24) || null;
  const name = String(req.body?.name || "").slice(0, 80) || null;
  const note = String(req.body?.note || "").slice(0, 300) || null;
  let payMode = "counter", inkressId = null, paymentUrl = null;
  if (payOn) {
    let accessToken; try { accessToken = await tokens.accessTokenFor(mid); } catch { return res.status(503).json({ error: "not_connected", message: "Online payment isn't ready — please pay at the counter." }); }
    try {
      const nm = String(name || `Table ${tableNo || ""}`).trim().split(/\s+/).filter(Boolean);
      const created = await createInkressOrder(core.cfg, accessToken, {
        referenceId: ref, total, currencyCode: prof.currency, kind: "online",
        title: `Table ${tableNo || "—"} · ${lines.reduce((s, l) => s + l.qty, 0)} item(s)`,
        customer: { email: String(req.body?.email || `table-${tableNo || "x"}@diner.local`).slice(0, 120), first_name: nm[0] || "Diner", last_name: nm.slice(1).join(" ") || (tableNo ? `Table ${tableNo}` : "Order") },
        metaData: { source: "restaurant-menu", table: tableNo, lines, subtotal, service_charge: service, tip },
      });
      payMode = "inkress"; inkressId = created.id != null ? String(created.id) : null; paymentUrl = created.payment_url || null;
    } catch (err) { return res.status(502).json({ error: "order_failed", message: err?.message }); }
  }
  const row = await db.one(`INSERT INTO orders (merchant_id, ref, table_no, customer_name, note, lines, subtotal, service_charge, tip, total, currency, state, pay_mode, inkress_order_id, payment_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new',$12,$13,$14) RETURNING *`,
    [mid, ref, tableNo, name, note, JSON.stringify(lines), subtotal, service, tip, total, prof.currency, payMode, inkressId, paymentUrl]);
  res.json({ ok: true, ref, pay_mode: payMode, payment_url: paymentUrl, total, order: { ref: row.ref, state: row.state } });
});
app.get("/api/public/order-status/:merchantId/:ref", async (req, res) => {
  const o = await db.one(`SELECT state, paid, pay_mode FROM orders WHERE merchant_id=$1 AND ref=$2`, [req.params.merchantId, req.params.ref]).catch(() => null);
  if (!o) return res.status(404).json({ error: "not_found" });
  res.json({ state: o.state, paid: o.paid, pay_mode: o.pay_mode });
});

/* ---- Webhook receiver: mark order paid ---- */
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const ref = o.reference_id || o.metadata?.reference_id;
    if (o.id != null) await db.run(`UPDATE orders SET paid=true WHERE merchant_id=$1 AND inkress_order_id=$2`, [merchantId, String(o.id)]);
    if (ref) await db.run(`UPDATE orders SET paid=true WHERE merchant_id=$1 AND ref=$2`, [merchantId, String(ref)]);
  } catch (err) { console.error(`[restaurant-menu] webhook failed: ${err?.message}`); }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[restaurant-menu] listening on ${HOST}:${PORT}`));

/* ---------------------------------------------------------------- helpers */
function cleanUrl(u) { const s = String(u || "").trim(); return /^https?:\/\//i.test(s) ? s.slice(0, 2000) : null; }
function parseTables(spec) {
  const out = [];
  for (const part of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { let a = Number(m[1]), b = Number(m[2]); if (a > b) [a, b] = [b, a]; for (let i = a; i <= Math.min(b, a + 199); i++) out.push(i); }
    else out.push(part);
  }
  return out.slice(0, 200);
}
function pickActiveMenu(menus) {
  const act = menus.filter((m) => m.active);
  if (!act.length) return null;
  const now = new Date(); const mins = now.getHours() * 60 + now.getMinutes();
  const scheduled = act.find((m) => m.start_min != null && m.end_min != null && ((m.start_min <= m.end_min && mins >= m.start_min && mins < m.end_min) || (m.start_min > m.end_min && (mins >= m.start_min || mins < m.end_min))));
  return scheduled || act.find((m) => m.start_min == null) || act[0];
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c, minimumFractionDigits: 0 }).format(n); } catch { return `${c} ${n}`; } }

function dinerPage(mid, prof, items, table) {
  const accent = prof.accent || "#c2410c";
  const groups = new Map();
  for (const i of items) { if (!groups.has(i.category)) groups.set(i.category, []); groups.get(i.category).push(i); }
  const sections = items.length ? [...groups.entries()].map(([cat, its]) => `<section><h2 class="cat">${esc(cat)}</h2>${its.map(itemCard).join("")}</section>`).join("")
    : `<p class="empty">This menu is being prepared. Check back soon.</p>`;
  const logo = prof.logo ? `<img class="logo" src="${esc(prof.logo)}" alt="">` : "";
  const cfg = JSON.stringify({ mid, accent, currency: prof.currency, table, payEnabled: prof.pay_enabled, tipping: prof.pay_enabled && prof.tipping_enabled, tipPresets: prof.tip_presets, serviceChargePct: prof.pay_enabled ? prof.service_charge_pct : 0,
    items: items.map((i) => ({ id: i.id, name: i.name, price: i.price, modifiers: i.modifiers })) });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(prof.name || "Menu")} · Order</title>
  <style>:root{--accent:${accent}}*{box-sizing:border-box}body{font-family:'Georgia',ui-serif,serif;margin:0;background:#fdfaf6;color:#2a2018;padding-bottom:96px}
  .wrap{max-width:560px;margin:0 auto;padding:0 18px}
  header{text-align:center;padding:30px 0 16px;border-bottom:2px solid #efe7dc}
  .logo{width:68px;height:68px;border-radius:50%;object-fit:cover;margin:0 auto 10px;display:block;border:1px solid #e7ddcf}
  h1{font-size:1.8rem;margin:0}.tagline{color:#8a7a66;margin:6px 0 0;font-style:italic;font-size:.95rem}
  .tbl{display:inline-block;margin-top:10px;font-family:system-ui,sans-serif;font-size:.78rem;background:var(--accent);color:#fff;padding:4px 12px;border-radius:20px;font-weight:600}
  .cat{font-size:.78rem;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin:26px 0 10px;font-family:system-ui,sans-serif;font-weight:700}
  .item{display:flex;gap:12px;padding:12px 0;border-bottom:1px dotted #e3d8c8;align-items:flex-start}
  .item .thumb{width:62px;height:62px;border-radius:10px;object-fit:cover;flex-shrink:0;border:1px solid #ece1d3}
  .it-body{flex:1}.it-name{font-size:1.05rem;font-weight:600}.it-desc{color:#8a7a66;font-size:.86rem;margin-top:2px;font-style:italic}
  .tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}.tag{font-family:system-ui,sans-serif;font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b5b47;background:#f1e9dd;border-radius:12px;padding:2px 7px}
  .it-side{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px}.it-price{font-variant-numeric:tabular-nums;white-space:nowrap;color:#5a4d3c;font-weight:600}
  .add{font-family:system-ui,sans-serif;border:1px solid var(--accent);color:var(--accent);background:#fff;border-radius:9px;padding:6px 12px;font-size:.82rem;font-weight:600;cursor:pointer}
  .add:active{background:var(--accent);color:#fff}
  .empty{text-align:center;color:#8a7a66;padding:50px 0;font-style:italic}
  footer{text-align:center;color:#b3a691;font-size:.74rem;margin:36px 0 10px;font-family:system-ui,sans-serif}
  .cartbar{position:fixed;left:0;right:0;bottom:0;background:var(--accent);color:#fff;font-family:system-ui,sans-serif;display:none;align-items:center;justify-content:space-between;padding:14px 18px;cursor:pointer;box-shadow:0 -6px 24px rgba(0,0,0,.16)}
  .cartbar.on{display:flex}.cartbar .c-count{background:rgba(255,255,255,.25);border-radius:20px;padding:3px 10px;font-weight:700;font-size:.85rem}.cartbar .c-total{font-weight:800}
  .scrim{position:fixed;inset:0;background:rgba(20,12,6,.5);display:none;align-items:flex-end;justify-content:center;z-index:9}.scrim.on{display:flex}
  .sheet{background:#fff;width:100%;max-width:560px;border-radius:18px 18px 0 0;max-height:88vh;overflow:auto;font-family:system-ui,sans-serif}
  .sheet-pad{padding:20px}.sheet h3{margin:0 0 12px;font-family:'Georgia',serif}
  .opt{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f0e9df}.opt label{flex:1}
  .crow{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #f0e9df;align-items:center}
  .qty{display:inline-flex;align-items:center;gap:10px}.qty button{width:30px;height:30px;border-radius:8px;border:1px solid #d8cfc2;background:#faf6f0;font-size:1rem;cursor:pointer}
  input,textarea,select{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d8cfc2;border-radius:10px;font-size:15px;font-family:inherit;margin-bottom:10px}
  .tips{display:flex;gap:8px;margin-bottom:10px}.tips button{flex:1;padding:9px;border:1px solid #d8cfc2;border-radius:9px;background:#fff;cursor:pointer;font-weight:600;color:#5a4d3c}.tips button.on{border-color:var(--accent);color:var(--accent);background:#fbeee6}
  .totals{font-size:.92rem;color:#5a4d3c}.totals .row{display:flex;justify-content:space-between;padding:3px 0}.totals .grand{font-weight:800;font-size:1.1rem;color:#2a2018;border-top:1px solid #ece1d3;margin-top:6px;padding-top:8px}
  .cta{width:100%;padding:14px;border:0;border-radius:11px;background:var(--accent);color:#fff;font-size:15px;font-weight:700;cursor:pointer;margin-top:8px}
  .done{text-align:center;padding:18px 0}.done .big{font-size:42px}
  </style></head>
  <body><div class="wrap"><header>${logo}<h1>${esc(prof.name || "Menu")}</h1>${prof.tagline ? `<p class="tagline">${esc(prof.tagline)}</p>` : ""}${table ? `<div class="tbl">Table ${esc(table)}</div>` : ""}</header>${sections}<footer>powered by Marketplace</footer></div>
  <div class="cartbar" id="cartbar"><span class="c-count" id="ccount">0</span><span>View order</span><span class="c-total" id="ctotal"></span></div>
  <div class="scrim" id="scrim"><div class="sheet"><div class="sheet-pad" id="sheet"></div></div></div>
  <script>window.__CFG=${cfg};</script><script>${dinerJs()}</script></body></html>`;
}
function itemCard(i) {
  const thumb = i.image_url ? `<img class="thumb" src="${esc(i.image_url)}" alt="">` : "";
  const tags = arr(i.tags).length ? `<div class="tags">${i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : "";
  return `<div class="item">${thumb}<div class="it-body"><div class="it-name">${esc(i.name)}</div>${i.description ? `<div class="it-desc">${esc(i.description)}</div>` : ""}${tags}</div>
    <div class="it-side"><div class="it-price">${money(Number(i.price), i.currency)}</div><button class="add" data-id="${i.id}">Add</button></div></div>`;
}
function dinerJs() {
  return `(function(){var C=window.__CFG,cart=[];var byId={};C.items.forEach(function(i){byId[i.id]=i});
  var money=function(n){try{return new Intl.NumberFormat('en-JM',{style:'currency',currency:C.currency,minimumFractionDigits:0}).format(n)}catch(e){return C.currency+' '+n}};
  var scrim=document.getElementById('scrim'),sheet=document.getElementById('sheet'),bar=document.getElementById('cartbar');
  document.querySelectorAll('.add').forEach(function(b){b.addEventListener('click',function(){openItem(byId[b.dataset.id])})});
  function openItem(it){var sel={};(it.modifiers||[]).forEach(function(g){sel[g.name]=[]});
    function render(){var unit=it.price;Object.keys(sel).forEach(function(gn){sel[gn].forEach(function(o){unit+=o.price||0})});
      sheet.innerHTML='<h3>'+esc(it.name)+'</h3>'+(it.modifiers||[]).map(function(g){return '<div class="cat">'+esc(g.name)+(g.required?' *':'')+'</div>'+g.options.map(function(o,oi){var on=sel[g.name].indexOf(o)>=0;return '<div class="opt"><label>'+esc(o.name)+(o.price?' (+'+money(o.price)+')':'')+'</label><input type="'+(g.multi?'checkbox':'radio')+'" name="g'+esc(g.name)+'" '+(on?'checked':'')+' data-g="'+esc(g.name)+'" data-o="'+oi+'"></div>'}).join('')}).join('')+
      '<button class="cta" id="addc">Add · '+money(unit)+'</button>';
      sheet.querySelectorAll('input[data-g]').forEach(function(inp){inp.addEventListener('change',function(){var g=inp.dataset.g,o=it.modifiers.find(function(x){return x.name===g}).options[inp.dataset.o];if(inp.type==='radio'){sel[g]=[o]}else{var k=sel[g].indexOf(o);if(k>=0)sel[g].splice(k,1);else sel[g].push(o)}render()})});
      document.getElementById('addc').addEventListener('click',function(){for(var i=0;i<it.modifiers.length;i++){var g=it.modifiers[i];if(g.required&&!sel[g.name].length){alert('Please choose '+g.name);return}}
        var opts=[];Object.keys(sel).forEach(function(gn){sel[gn].forEach(function(o){opts.push({group:gn,option:o.name,price:o.price||0})})});
        cart.push({item_id:it.id,name:it.name,qty:1,unit:unit,options:opts});close();sync()})}
    render();open()}
  function open(){scrim.classList.add('on')}function close(){scrim.classList.remove('on')}
  function lineTotal(l){return l.unit*l.qty}
  function sync(){var n=cart.reduce(function(s,l){return s+l.qty},0),sub=cart.reduce(function(s,l){return s+lineTotal(l)},0);
    document.getElementById('ccount').textContent=n;document.getElementById('ctotal').textContent=money(sub);bar.classList.toggle('on',n>0)}
  bar.addEventListener('click',openCart);
  function openCart(){var sub=cart.reduce(function(s,l){return s+lineTotal(l)},0);
    var svc=C.serviceChargePct>0?Math.round(sub*C.serviceChargePct)/100:0;window.__tip=window.__tip||0;
    function totals(){var tip=window.__tip||0;var grand=sub+svc+tip;return '<div class="totals"><div class="row"><span>Subtotal</span><span>'+money(sub)+'</span></div>'+(svc?'<div class="row"><span>Service ('+C.serviceChargePct+'%)</span><span>'+money(svc)+'</span></div>':'')+(C.tipping?'<div class="row"><span>Tip</span><span>'+money(tip)+'</span></div>':'')+'<div class="row grand"><span>Total</span><span>'+money(grand)+'</span></div></div>'}
    sheet.innerHTML='<h3>Your order'+(C.table?' · Table '+esc(C.table):'')+'</h3>'+(cart.length?cart.map(function(l,i){return '<div class="crow"><div><b>'+esc(l.name)+'</b>'+(l.options.length?'<div style="color:#8a7a66;font-size:.82rem">'+l.options.map(function(o){return esc(o.option)}).join(', ')+'</div>':'')+'</div><div class="qty"><button data-d="'+i+'" data-x="-1">−</button><span>'+l.qty+'</span><button data-d="'+i+'" data-x="1">+</button></div></div>'}).join(''):'<p style="color:#8a7a66">Your cart is empty.</p>')+
      (C.tipping?'<div class="cat">Tip</div><div class="tips">'+C.tipPresets.map(function(p){return '<button data-tip="'+p+'">'+p+'%</button>'}).join('')+'<button data-tip="0">None</button></div>':'')+
      '<input id="cname" placeholder="Your name (optional)"><textarea id="cnote" rows="2" placeholder="Notes for the kitchen (allergies, no onions…)"></textarea>'+
      totals()+'<button class="cta" id="place">'+(C.payEnabled?'Pay & send to kitchen':'Send order to kitchen')+'</button>';
    sheet.querySelectorAll('[data-d]').forEach(function(b){b.addEventListener('click',function(){var i=+b.dataset.d;cart[i].qty+=+b.dataset.x;if(cart[i].qty<1)cart.splice(i,1);sync();if(!cart.length){close();return}openCart()})});
    sheet.querySelectorAll('[data-tip]').forEach(function(b){b.addEventListener('click',function(){window.__tip=Math.round(sub*(+b.dataset.tip))/100;sheet.querySelectorAll('[data-tip]').forEach(function(x){x.classList.remove('on')});b.classList.add('on');document.querySelector('.totals').outerHTML=totals()})});
    document.getElementById('place').addEventListener('click',place);open()}
  function place(){var btn=document.getElementById('place');btn.disabled=true;btn.textContent='Sending…';
    var body={table:C.table,name:(document.getElementById('cname')||{}).value||'',note:(document.getElementById('cnote')||{}).value||'',tip:window.__tip||0,lines:cart.map(function(l){return {item_id:l.item_id,qty:l.qty,options:l.options.map(function(o){return {group:o.group,option:o.option}})}})};
    fetch('/api/public/order/'+C.mid,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){
      if(j.payment_url){window.location.href=j.payment_url;return}
      if(j.ok){cart=[];sync();sheet.innerHTML='<div class="done"><div class="big">✓</div><h3>Order sent'+(C.table?' for Table '+esc(C.table):'')+'!</h3><p style="color:#8a7a66">The kitchen has your order. '+(C.payEnabled?'':'Please pay at the counter.')+'</p><button class="cta" onclick="location.reload()">Done</button></div>'}
      else{btn.disabled=false;btn.textContent='Try again';alert(j.message||'Something went wrong.')}}).catch(function(){btn.disabled=false;btn.textContent='Try again'})}
  scrim.addEventListener('click',function(e){if(e.target===scrim)close()});
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  })();`;
}
