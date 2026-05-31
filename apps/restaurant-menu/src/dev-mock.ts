/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

let ITEMS: any[] = [
  { id: 1, category: "Starters", name: "Festival & Saltfish Fritters", description: "Golden festival with flaked saltfish, scotch-bonnet aioli.", price: 850, currency: "JMD", available: true, sort: 1, image_url: null, tags: ["spicy"], modifiers: [], menu_id: null, product_id: null },
  { id: 2, category: "Starters", name: "Pumpkin Soup", description: "Creamy, spiced, with dumplings.", price: 600, currency: "JMD", available: true, sort: 2, image_url: null, tags: ["veg"], modifiers: [], menu_id: null, product_id: null },
  { id: 3, category: "Mains", name: "Jerk Chicken", description: "Quarter chicken, rice & peas, festival.", price: 1800, currency: "JMD", available: true, sort: 1, image_url: null, tags: ["spicy"], modifiers: [{ name: "Portion", required: true, multi: false, options: [{ name: "Quarter", price: 0 }, { name: "Half", price: 700 }] }, { name: "Extras", required: false, multi: true, options: [{ name: "Extra festival", price: 200 }, { name: "Slaw", price: 250 }] }], menu_id: null, product_id: null },
  { id: 4, category: "Mains", name: "Curry Goat", description: "Slow-cooked, white rice, plantain.", price: 2200, currency: "JMD", available: true, sort: 2, image_url: null, tags: [], modifiers: [], menu_id: null, product_id: null },
  { id: 5, category: "Mains", name: "Brown Stew Snapper", description: "Whole snapper, bammy.", price: 2600, currency: "JMD", available: false, sort: 3, image_url: null, tags: ["GF"], modifiers: [], menu_id: null, product_id: null },
  { id: 6, category: "Drinks", name: "Sorrel", description: "House-brewed, ginger & pimento.", price: 400, currency: "JMD", available: true, sort: 1, image_url: null, tags: [], modifiers: [], menu_id: null, product_id: null },
  { id: 7, category: "Drinks", name: "Ting", description: "Grapefruit soda.", price: 300, currency: "JMD", available: true, sort: 2, image_url: null, tags: [], modifiers: [], menu_id: null, product_id: null },
];
let IID = 7;
let MENUS: any[] = [];
let MNID = 0;
let PROFILE: any = { name: "Irie Eats Kitchen", logo: null, tagline: "Fresh Jamaican kitchen", accent: "#c2410c", currency: "JMD", pay_enabled: true, service_charge_pct: 10, tipping_enabled: true, tip_presets: [10, 15, 20] };
let ORDERS: any[] = [
  { id: 1, ref: "rm-183-a", table_no: "4", customer_name: "Walk-in", note: "No scotch bonnet please", lines: [{ name: "Jerk Chicken", qty: 2, unit: 1800, line_total: 3600, options: [{ group: "Portion", option: "Quarter" }] }, { name: "Sorrel", qty: 2, unit: 400, line_total: 800, options: [] }], subtotal: 4400, service_charge: 440, tip: 660, total: 5500, currency: "JMD", state: "new", pay_mode: "inkress", paid: true, created_at: new Date(Date.now() - 4 * 6e4).toISOString() },
  { id: 2, ref: "rm-183-b", table_no: "7", customer_name: null, note: null, lines: [{ name: "Curry Goat", qty: 1, unit: 2200, line_total: 2200, options: [] }], subtotal: 2200, service_charge: 0, tip: 0, total: 2200, currency: "JMD", state: "preparing", pay_mode: "counter", paid: false, created_at: new Date(Date.now() - 12 * 6e4).toISOString() },
];
let OID = 2;

const cats = () => [...new Set(ITEMS.map((i) => i.category))];

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 70));
    const im = u.pathname.match(/\/api\/items\/(\d+)/);
    const mm = u.pathname.match(/\/api\/menus\/(\d+)/);
    const om = u.pathname.match(/\/api\/orders\/(\d+)/);

    if (u.pathname === "/api/menu" && method === "GET")
      return json({ items: ITEMS, categories: cats(), menus: MENUS, profile: PROFILE, public_url: location.origin + "/m/183", storage: false, products: true, webhook_realtime: true, can_pay: true, stats: { items: ITEMS.length, available: ITEMS.filter((i) => i.available).length, categories: cats().length } });
    if (u.pathname === "/api/settings" && method === "PATCH") { Object.assign(PROFILE, body, { tip_presets: body.tip_presets?.length ? body.tip_presets : PROFILE.tip_presets }); return json({ profile: PROFILE }); }
    if (u.pathname === "/api/menus" && method === "POST") { const mn = { id: ++MNID, name: body.name, active: body.active !== false, start_min: body.start_min ?? null, end_min: body.end_min ?? null, sort: MNID }; MENUS.push(mn); return json({ menu: mn }, 201); }
    if (mm && method === "PATCH") { const mn = MENUS.find((x) => x.id === Number(mm[1])); Object.assign(mn, body); return json({ menu: mn }); }
    if (mm && method === "DELETE") { MENUS = MENUS.filter((x) => x.id !== Number(mm[1])); return json({ ok: true }); }
    if (u.pathname === "/api/items" && method === "POST") { const it = { id: ++IID, category: body.category || "Mains", name: body.name, description: body.description || null, price: Number(body.price) || 0, currency: "JMD", available: true, sort: IID, image_url: body.image_url || null, tags: body.tags || [], modifiers: body.modifiers || [], menu_id: body.menu_id ?? null, product_id: body.product_id || null }; ITEMS.push(it); return json({ item: it }, 201); }
    if (u.pathname === "/api/items/reorder" && method === "POST") { (body.ids || []).forEach((id: number, n: number) => { const it = ITEMS.find((x) => x.id === id); if (it) it.sort = n; }); ITEMS.sort((a, b) => a.sort - b.sort); return json({ ok: true }); }
    if (im && method === "PATCH") { const it = ITEMS.find((x) => x.id === Number(im[1])); Object.assign(it, body); return json({ item: it }); }
    if (im && method === "DELETE") { ITEMS = ITEMS.filter((x) => x.id !== Number(im[1])); return json({ ok: true }); }
    if (u.pathname === "/api/products") return json({ products: [
      { id: 201, title: "Bag of Blue Mountain Coffee", description: "250g whole bean", price: 1500, image: null, currency: "JMD" },
      { id: 202, title: "Branded Tote Bag", description: null, price: 900, image: null, currency: "JMD" },
    ].filter((p) => { const q = (u.searchParams.get("q") || "").toLowerCase(); return q ? p.title.toLowerCase().includes(q) : true; }) });
    if (u.pathname === "/api/import-products" && method === "POST") { for (const p of body.products || []) ITEMS.push({ id: ++IID, category: body.category || "Mains", name: p.title, description: p.description || null, price: Number(p.price) || 0, currency: "JMD", available: true, sort: IID, image_url: p.image || null, tags: [], modifiers: [], menu_id: null, product_id: String(p.id) }); return json({ imported: (body.products || []).length }); }
    if (u.pathname === "/api/upload") return json({ url: "https://placehold.co/300x300/png" });
    if (u.pathname === "/api/qr") return json({ url: location.origin + "/m/183", data_url: "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(location.origin + "/m/183") });
    if (u.pathname === "/api/orders" && method === "GET") { const live = ORDERS.filter((o) => o.state !== "served" && o.state !== "cancelled"); return json({ orders: live, stats: { today_orders: ORDERS.length, today_revenue: ORDERS.reduce((s, o) => s + (o.state !== "cancelled" ? o.total : 0), 0) } }); }
    if (om && method === "PATCH") { const o = ORDERS.find((x) => x.id === Number(om[1])); if (o) { const flow = ["new", "preparing", "ready", "served"]; if (body.advance) o.state = flow[Math.min(flow.length - 1, flow.indexOf(o.state) + 1)]; if (body.state) o.state = body.state; if (body.paid != null) o.paid = body.paid; } return json({ order: o }); }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "irie-eats", name: "Irie Eats Kitchen", currency_code: "JMD", email: "hello@irieeats.com", logo: null },
    user: { id: 90, name: "Owner", email: "owner@irieeats.com" },
    scopes: ["orders:write", "offline_access", "products:read", "webhooks:manage"],
  };
}
