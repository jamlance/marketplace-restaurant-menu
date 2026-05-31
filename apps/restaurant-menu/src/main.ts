import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Mod { name: string; required: boolean; multi: boolean; options: { name: string; price: number }[]; }
interface Item { id: number; category: string; name: string; description: string | null; price: number; currency: string; available: boolean; sort: number; image_url: string | null; tags: string[]; modifiers: Mod[]; menu_id: number | null; product_id: string | null; }
interface Menu { id: number; name: string; active: boolean; start_min: number | null; end_min: number | null; sort: number; }
interface Profile { name: string | null; logo: string | null; tagline: string | null; accent: string; currency: string; pay_enabled: boolean; service_charge_pct: number; tipping_enabled: boolean; tip_presets: number[]; }
interface MenuData { items: Item[]; categories: string[]; menus: Menu[]; profile: Profile; public_url: string; storage: boolean; products: boolean; webhook_realtime: boolean; can_pay: boolean; stats: { items: number; available: number; categories: number }; }
interface Order { id: number; ref: string; table_no: string | null; customer_name: string | null; note: string | null; lines: { name: string; qty: number; unit: number; line_total: number; options: { group: string; option: string }[] }[]; subtotal: number; service_charge: number; tip: number; total: number; currency: string; state: string; pay_mode: string; paid: boolean; created_at: string; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let data: MenuData | null = null;
let shell: ReturnType<typeof mountShell>;

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "utensils",
    brandLogo: "/logo.svg",
    title: "Restaurant Menu",
    subtitle: `${merchantName} · menu, QR ordering & kitchen`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "menu", label: "Menu", icon: "utensils", render: renderMenu },
      { id: "orders", label: "Orders", icon: "inbox", render: renderOrders },
      { id: "share", label: "QR & Share", icon: "qr", render: renderShare },
      { id: "settings", label: "Settings", icon: "settings", render: renderSettings },
    ],
  });
})();

async function load(): Promise<MenuData> { data = await bvApi<MenuData>("/api/menu"); return data; }

/* ---------------------------------------------------------------------- Menu */
async function renderMenu(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let d: MenuData;
  try { d = await load(); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  host.append(statRow([
    { k: "Menu items", v: String(d.stats.items), icon: "utensils" },
    { k: "On menu now", v: String(d.stats.available), tone: "ok", icon: "check" },
    { k: "Categories", v: String(d.stats.categories), tone: "accent", icon: "list" },
  ]));

  const actions = h("div", { class: "rm-toolbar" },
    d.products ? h("button", { class: "ghost", onClick: () => catalogImport(d) }, iconEl("box", 15), "Import from catalog") : null,
    h("button", { class: "primary", onClick: () => openItem(null, d) }, iconEl("plus", 15), "Add item"));
  if (!d.items.length) { host.append(card({ title: "Menu", action: actions, body: emptyState({ icon: "utensils", title: "No dishes yet", text: "Add your first item — or import from your Inkress catalog." }) })); return; }

  const groups = new Map<string, Item[]>();
  for (const it of d.items) { if (!groups.has(it.category)) groups.set(it.category, []); groups.get(it.category)!.push(it); }
  const body = h("div", { class: "rm-cats" });
  for (const [cat, its] of groups) {
    const rows = h("div", { class: "rm-itemlist" });
    its.forEach((i, idx) => rows.append(itemRow(i, its, idx, d)));
    body.append(h("div", { class: "rm-cat" },
      h("div", { class: "rm-cat-head" }, h("span", { class: "rm-cat-name" }, cat), h("span", { class: "bv-muted" }, `${its.length} item${its.length === 1 ? "" : "s"}`)),
      rows));
  }
  host.append(card({ title: "Menu", action: actions, body }));
}

function itemRow(i: Item, siblings: Item[], idx: number, d: MenuData) {
  const thumb = h("span", { class: "rm-thumb" + (i.image_url ? "" : " is-empty"), style: i.image_url ? { backgroundImage: `url('${i.image_url}')` } : {} });
  const badges = h("div", { class: "rm-badges" },
    i.available ? pill("on menu", "ok") : pill("hidden"),
    i.modifiers.length ? pill(`${i.modifiers.length} option${i.modifiers.length === 1 ? "" : "s"}`) : null,
    ...i.tags.slice(0, 3).map((t) => h("span", { class: "rm-tag" }, t)));
  return h("div", { class: "rm-item-row" + (i.available ? "" : " is-off") }, thumb,
    h("div", { class: "rm-item-main" }, h("strong", null, i.name), i.description ? h("div", { class: "bv-muted rm-desc" }, i.description) : null, badges),
    h("div", { class: "rm-item-price" }, fmtMoney(i.price, i.currency)),
    h("div", { class: "rm-row-actions" },
      h("button", { class: "ghost sm", disabled: idx === 0, title: "Move up", onClick: () => reorder(siblings, idx, -1) }, "↑"),
      h("button", { class: "ghost sm", disabled: idx === siblings.length - 1, title: "Move down", onClick: () => reorder(siblings, idx, 1) }, "↓"),
      h("button", { class: "ghost sm", onClick: () => toggle(i) }, i.available ? "Hide" : "Show"),
      h("button", { class: "ghost sm", onClick: () => openItem(i, d) }, iconEl("edit", 14)),
      h("button", { class: "ghost sm", onClick: () => del(i) }, iconEl("trash", 14))));
}

async function reorder(siblings: Item[], idx: number, dir: number) {
  const j = idx + dir; if (j < 0 || j >= siblings.length) return;
  const arr = siblings.slice(); const t = arr[idx]!; arr[idx] = arr[j]!; arr[j] = t;
  try { await bvApi("/api/items/reorder", { method: "POST", body: JSON.stringify({ ids: arr.map((x) => x.id) }) }); shell.select("menu"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}
async function toggle(i: Item) {
  try { await bvApi(`/api/items/${i.id}`, { method: "PATCH", body: JSON.stringify({ available: !i.available }) }); shell.select("menu"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}
async function del(i: Item) {
  if (!confirm(`Remove “${i.name}” from the menu?`)) return;
  try { await bvApi(`/api/items/${i.id}`, { method: "DELETE" }); flash("Removed", "success"); shell.select("menu"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}

function openItem(i: Item | null, d: MenuData) {
  const name = h("input", { value: i?.name || "", placeholder: "e.g. Jerk Chicken" }) as HTMLInputElement;
  const known = [...new Set([...d.categories, "Starters", "Mains", "Sides", "Drinks", "Desserts"])];
  const cat = h("input", { value: i?.category || "Mains", placeholder: "Mains", list: "rm-cat-list" }) as HTMLInputElement;
  const datalist = h("datalist", { id: "rm-cat-list" }, ...known.map((c) => h("option", { value: c }))) as HTMLDataListElement;
  const desc = h("input", { value: i?.description || "", placeholder: "Served with rice & peas (optional)" }) as HTMLInputElement;
  const price = h("input", { type: "number", min: "0", step: "0.01", value: i ? String(i.price) : "", placeholder: "0.00" }) as HTMLInputElement;
  const tags = h("input", { value: (i?.tags || []).join(", "), placeholder: "veg, spicy, GF (comma separated)" }) as HTMLInputElement;
  const menuSel = h("select", null, h("option", { value: "" }, "All menus"), ...d.menus.map((m) => h("option", { value: String(m.id), selected: i?.menu_id === m.id }, m.name))) as HTMLSelectElement;

  // image
  let imageUrl = i?.image_url || "";
  const preview = h("span", { class: "rm-thumb" + (imageUrl ? "" : " is-empty"), style: imageUrl ? { backgroundImage: `url('${imageUrl}')` } : {} });
  const fileInput = h("input", { type: "file", accept: "image/*", style: { display: "none" }, onChange: async (e: any) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader(); reader.onload = async () => {
      try { const up = await bvApi<{ url: string }>("/api/upload", { method: "POST", body: JSON.stringify({ data: reader.result }) }); imageUrl = up.url; preview.style.backgroundImage = `url('${imageUrl}')`; preview.classList.remove("is-empty"); flash("Image uploaded", "success"); }
      catch (err: any) { toast(err?.message || "Upload failed", "error"); }
    }; reader.readAsDataURL(file);
  } }) as HTMLInputElement;
  const upBtn = h("button", { class: "ghost sm", disabled: !d.storage, title: d.storage ? "" : "Image hosting not configured", onClick: () => fileInput.click() }, iconEl("download", 14), "Upload");
  const clearImg = h("button", { class: "ghost sm", onClick: () => { imageUrl = ""; preview.style.backgroundImage = ""; preview.classList.add("is-empty"); } }, "Clear");

  const mods = modifierEditor(i?.modifiers || []);

  const body = h("div", { class: "rm-form" },
    field("Dish name", name),
    h("div", { class: "rm-form-grid" }, field("Category", h("span", null, cat, datalist)), field(`Price (${currency})`, price)),
    field("Description", desc),
    field("Dietary tags", tags),
    d.menus.length ? field("Menu", menuSel) : null,
    field("Photo", h("div", { class: "rm-img-row" }, preview, h("div", { class: "rm-imgbtns" }, upBtn, imageUrl ? clearImg : null, fileInput))),
    field("Options & add-ons", mods.el));
  const save = async () => {
    if (!name.value.trim()) { toast("Name is required", "warning"); return; }
    const payload: any = { name: name.value, category: cat.value, description: desc.value, price: Number(price.value) || 0, tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean), image_url: imageUrl || null, modifiers: mods.get(), menu_id: menuSel.value ? Number(menuSel.value) : null };
    try {
      if (i) await bvApi(`/api/items/${i.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await bvApi("/api/items", { method: "POST", body: JSON.stringify(payload) });
      flash(i ? "Saved" : "Item added", "success"); shell.select("menu");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: i ? "Edit item" : "Add menu item", body, actions: [{ label: i ? "Save" : "Add", primary: true, onClick: () => { void save(); } }] });
}

function modifierEditor(initial: Mod[]) {
  const list = h("div", { class: "rm-mods" });
  const groups: Mod[] = JSON.parse(JSON.stringify(initial || []));
  const render = () => {
    list.innerHTML = "";
    groups.forEach((g, gi) => {
      const gName = h("input", { value: g.name, placeholder: "Group, e.g. Size", onInput: (e: any) => { g.name = e.target.value; } }) as HTMLInputElement;
      const req = h("input", { type: "checkbox", checked: g.required, onChange: (e: any) => { g.required = e.target.checked; } }) as HTMLInputElement;
      const multi = h("input", { type: "checkbox", checked: g.multi, onChange: (e: any) => { g.multi = e.target.checked; } }) as HTMLInputElement;
      const opts = h("div", { class: "rm-mod-opts" });
      g.options.forEach((o, oi) => opts.append(h("div", { class: "rm-mod-opt" },
        h("input", { value: o.name, placeholder: "Option name", onInput: (e: any) => { o.name = e.target.value; } }),
        h("input", { type: "number", step: "0.01", value: String(o.price), placeholder: "+0", onInput: (e: any) => { o.price = Number(e.target.value) || 0; } }),
        h("button", { class: "ghost sm", onClick: () => { g.options.splice(oi, 1); render(); } }, iconEl("trash", 12)))));
      list.append(h("div", { class: "rm-mod-group" },
        h("div", { class: "rm-mod-head" }, gName, h("label", { class: "rm-check" }, req, " Required"), h("label", { class: "rm-check" }, multi, " Multi"), h("button", { class: "ghost sm", onClick: () => { groups.splice(gi, 1); render(); } }, iconEl("trash", 13))),
        opts, h("button", { class: "ghost sm", onClick: () => { g.options.push({ name: "", price: 0 }); render(); } }, iconEl("plus", 12), "Add option")));
    });
    list.append(h("button", { class: "ghost sm", onClick: () => { groups.push({ name: "", required: false, multi: false, options: [{ name: "", price: 0 }] }); render(); } }, iconEl("plus", 13), "Add option group"));
  };
  render();
  return { el: list, get: () => groups.map((g) => ({ ...g, options: g.options.filter((o) => o.name.trim()) })).filter((g) => g.options.length) };
}

function catalogImport(d: MenuData) {
  const search = h("input", { placeholder: "Search your products…" }) as HTMLInputElement;
  const cat = h("input", { value: "Mains", placeholder: "Add to category" }) as HTMLInputElement;
  const results = h("div", { class: "rm-cat-results" });
  const picked = new Set<number>();
  const store: any[] = [];
  const loadP = async () => {
    results.innerHTML = ""; results.append(h("div", { class: "bv-muted", style: { padding: "8px 0" } }, "Loading…"));
    try {
      const r = await bvApi<{ products: any[]; unavailable?: boolean }>(`/api/products?q=${encodeURIComponent(search.value.trim())}`);
      results.innerHTML = ""; store.length = 0; store.push(...r.products);
      if (r.unavailable) { results.append(h("div", { class: "bv-muted" }, "Catalog access isn't enabled.")); return; }
      if (!r.products.length) { results.append(h("div", { class: "bv-muted", style: { padding: "8px 0" } }, "No products found.")); return; }
      for (const p of r.products) {
        const cb = h("input", { type: "checkbox", onChange: (e: any) => { e.target.checked ? picked.add(p.id) : picked.delete(p.id); } }) as HTMLInputElement;
        results.append(h("label", { class: "rm-cat-row" }, cb,
          h("span", { class: "rm-cat-thumb" + (p.image ? "" : " is-empty"), style: p.image ? { backgroundImage: `url('${p.image}')` } : {} }),
          h("span", { class: "rm-cat-main" }, h("strong", null, p.title), h("span", { class: "bv-muted" }, fmtMoney(p.price, p.currency)))));
      }
    } catch (err: any) { results.innerHTML = ""; results.append(h("div", { class: "bv-muted" }, err?.message || "Couldn't load")); }
  };
  let t: any; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(loadP, 250); });
  openModal({ title: "Import from catalog", body: h("div", { class: "rm-catalog" }, h("div", { class: "rm-form-grid" }, field("Search", search), field("Category", cat)), results), actions: [
    { label: "Import selected", primary: true, onClick: () => { void (async () => {
      const products = store.filter((p) => picked.has(p.id));
      if (!products.length) { toast("Pick at least one product", "warning"); return; }
      try { const r = await bvApi<{ imported: number }>("/api/import-products", { method: "POST", body: JSON.stringify({ category: cat.value, products }) }); document.querySelector(".bv-scrim")?.remove(); flash(`Imported ${r.imported}`, "success"); shell.select("menu"); }
      catch (err: any) { toast(err?.message || "error", "error"); }
    })(); } }] });
  void loadP();
}

/* -------------------------------------------------------------------- Orders */
async function renderOrders(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let res: { orders: Order[]; stats: { today_orders: number; today_revenue: number } };
  try { res = await bvApi("/api/orders?refresh=1"); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  host.append(statRow([
    { k: "Live orders", v: String(res.orders.length), tone: "accent", icon: "inbox" },
    { k: "Today's orders", v: String(res.stats.today_orders), icon: "receipt" },
    { k: "Today's revenue", v: fmtMoney(res.stats.today_revenue, currency), tone: "ok", icon: "coins" },
  ]));

  const refresh = h("button", { class: "ghost", onClick: () => shell.select("orders") }, iconEl("clock", 14), "Refresh");
  if (!res.orders.length) { host.append(card({ title: "Kitchen", action: refresh, body: emptyState({ icon: "inbox", title: "No live orders", text: "When a diner places an order from the QR menu, it appears here." }) })); return; }

  const grid = h("div", { class: "rm-orders" });
  for (const o of res.orders) grid.append(orderCard(o));
  host.append(card({ title: "Kitchen — live orders", action: refresh, body: grid }));
}

function orderCard(o: Order) {
  const stTone: Record<string, "ok" | "accent" | "bad" | undefined> = { new: "accent", preparing: undefined, ready: "ok", served: "ok", cancelled: "bad" };
  const next: Record<string, string> = { new: "Start preparing", preparing: "Mark ready", ready: "Mark served" };
  const head = h("div", { class: "rm-order-head" },
    h("div", null, h("strong", null, o.table_no ? `Table ${o.table_no}` : "Order"), h("span", { class: "bv-muted rm-order-when" }, " · " + relTime(o.created_at))),
    h("div", { class: "rm-order-badges" }, pill(o.state, stTone[o.state]), o.pay_mode === "inkress" ? (o.paid ? pill("paid", "ok") : pill("unpaid", "bad")) : pill("pay at counter")));
  const lines = h("div", { class: "rm-order-lines" });
  for (const l of o.lines) lines.append(h("div", { class: "rm-order-line" },
    h("span", { class: "rm-ol-qty" }, `${l.qty}×`),
    h("div", null, h("span", null, l.name), l.options.length ? h("div", { class: "bv-muted rm-ol-opts" }, l.options.map((x) => x.option).join(", ")) : null),
    h("span", { class: "rm-ol-price" }, fmtMoney(l.line_total, o.currency))));
  if (o.note) lines.append(h("div", { class: "rm-order-note" }, iconEl("alert", 13), o.note));
  const foot = h("div", { class: "rm-order-foot" },
    h("span", { class: "rm-order-total" }, fmtMoney(o.total, o.currency) + (o.tip ? ` · tip ${fmtMoney(o.tip, o.currency)}` : "")),
    h("div", { class: "rm-order-actions" },
      o.pay_mode === "counter" && !o.paid ? h("button", { class: "ghost sm", onClick: () => mark(o, { paid: true }) }, "Mark paid") : null,
      next[o.state] ? h("button", { class: "primary sm", onClick: () => mark(o, { advance: true }) }, next[o.state]!) : null,
      o.state !== "cancelled" && o.state !== "served" ? h("button", { class: "ghost sm", onClick: () => mark(o, { state: "cancelled" }) }, iconEl("x", 13)) : null));
  return h("div", { class: "rm-order-card" }, head, lines, foot);
}
async function mark(o: Order, body: any) {
  try { await bvApi(`/api/orders/${o.id}`, { method: "PATCH", body: JSON.stringify(body) }); shell.select("orders"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}

/* ----------------------------------------------------------------- QR & Share */
async function renderShare(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  const d = data || (await load().catch(() => null));
  let qr: { url: string; data_url: string };
  try { qr = await bvApi("/api/qr"); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";
  const publicUrl = d?.public_url || qr.url;

  host.append(card({ title: "Diner menu link", body: h("div", { class: "rm-share" },
    h("div", { class: "rm-qr" }, h("img", { src: qr.data_url, alt: "Menu QR code", width: 220, height: 220 })),
    h("div", { class: "rm-share-info" },
      h("p", { class: "bv-muted" }, d?.profile.pay_enabled ? "Diners scan, browse your live menu, and order to the kitchen — paying online via Inkress." : "Diners scan, browse your live menu, and send orders to the kitchen (pay at the counter)."),
      h("div", { class: "rm-link" }, h("input", { class: "rm-link-input", readonly: true, value: publicUrl }), h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(publicUrl); flash("Link copied", "success"); } }, iconEl("copy", 14), "Copy")),
      h("div", { class: "rm-share-btns" },
        h("a", { class: "bv-btn", href: publicUrl, target: "_blank", rel: "noopener" }, iconEl("external", 14), "Preview menu"),
        h("a", { class: "bv-btn", href: qr.data_url, target: "_blank", rel: "noopener", download: "menu-qr.png" }, iconEl("download", 14), "Download QR")),
    )) }));

  // Table tents
  const range = h("input", { value: "1-12", placeholder: "1-12 or 1,2,5" }) as HTMLInputElement;
  host.append(card({ title: "Printable table tents", body: h("div", { class: "rm-share-info" },
    h("p", { class: "bv-muted" }, "Generate a printable sheet of QR cards — one per table. Each table's QR opens the menu pre-tagged with the table number, so orders arrive labelled."),
    h("div", { class: "rm-link" }, field("Tables", range),
      h("button", { class: "primary", style: { alignSelf: "flex-end" }, onClick: () => window.open(`/api/table-tents?tables=${encodeURIComponent(range.value || "1-12")}`, "_blank") }, iconEl("qr", 14), "Open printable sheet")),
  ) }));
}

/* ------------------------------------------------------------------ Settings */
async function renderSettings(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let d: MenuData;
  try { d = await load(); }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";
  const p = d.profile;

  const name = h("input", { value: p.name || "", placeholder: merchantName }) as HTMLInputElement;
  const tagline = h("input", { value: p.tagline || "", placeholder: "Fresh Jamaican kitchen (optional)" }) as HTMLInputElement;
  const accent = h("input", { type: "color", value: p.accent || "#c2410c" }) as HTMLInputElement;
  const payEnabled = h("input", { type: "checkbox", checked: p.pay_enabled }) as HTMLInputElement;
  const service = h("input", { type: "number", min: "0", max: "100", step: "0.5", value: String(p.service_charge_pct) }) as HTMLInputElement;
  const tipping = h("input", { type: "checkbox", checked: p.tipping_enabled }) as HTMLInputElement;
  const tips = h("input", { value: (p.tip_presets || []).join(", "), placeholder: "10, 15, 20" }) as HTMLInputElement;

  const payHint = h("div", { class: "bv-muted rm-hint" });
  const updateHint = () => { payHint.textContent = payEnabled.checked ? "Online payment ON — diners pay via Inkress; service charge & tips apply." : "Online payment OFF — orders go to the kitchen; diners pay at the counter."; };
  payEnabled.addEventListener("change", updateHint); updateHint();

  const saveBtn = h("button", { class: "primary", onClick: () => { void saveSettings(); } }, "Save settings");
  const saveSettings = async () => {
    const payload = { name: name.value || null, tagline: tagline.value || null, accent: accent.value, pay_enabled: payEnabled.checked, service_charge_pct: Number(service.value) || 0, tipping_enabled: tipping.checked, tip_presets: tips.value.split(",").map((t) => Number(t.trim())).filter((n) => !isNaN(n)) };
    try { await bvApi("/api/settings", { method: "PATCH", body: JSON.stringify(payload) }); flash("Settings saved", "success"); shell.select("settings"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  };

  host.append(card({ title: "Menu branding", body: h("div", { class: "rm-form" },
    h("div", { class: "rm-form-grid" }, field("Menu name", name), field("Accent", accent)),
    field("Tagline", tagline)) }));

  host.append(card({ title: "Ordering & payment", action: saveBtn, body: h("div", { class: "rm-form" },
    h("label", { class: "rm-check rm-toggle" }, payEnabled, " Enable online payment (Inkress) at checkout"),
    payHint,
    h("div", { class: "rm-form-grid" }, field("Service charge %", service), field("Tip presets %", tips)),
    h("label", { class: "rm-check" }, tipping, " Offer tipping on the diner checkout")) }));

  // Menus (multiple menus + scheduling)
  const menuList = h("div", { class: "rm-menulist" });
  const renderMenus = () => {
    menuList.innerHTML = "";
    if (!d.menus.length) menuList.append(h("div", { class: "bv-muted", style: { padding: "6px 0" } }, "One menu shown to all diners. Add named menus (Breakfast, Lunch…) to schedule by time of day."));
    for (const m of d.menus) menuList.append(h("div", { class: "rm-menu-row" },
      h("div", null, h("strong", null, m.name), m.active ? pill("active", "ok") : pill("off"), m.start_min != null ? h("span", { class: "bv-muted" }, ` ${fmtMin(m.start_min)}–${fmtMin(m.end_min)}`) : null),
      h("div", { class: "rm-row-actions" },
        h("button", { class: "ghost sm", onClick: () => openMenu(m) }, iconEl("edit", 13)),
        h("button", { class: "ghost sm", onClick: async () => { if (!confirm(`Delete menu “${m.name}”? Items move to All menus.`)) return; await bvApi(`/api/menus/${m.id}`, { method: "DELETE" }); shell.select("settings"); } }, iconEl("trash", 13)))));
  };
  renderMenus();
  host.append(card({ title: "Menus", action: h("button", { class: "primary", onClick: () => openMenu(null) }, iconEl("plus", 14), "New menu"), body: menuList }));
}

function openMenu(m: Menu | null) {
  const name = h("input", { value: m?.name || "", placeholder: "e.g. Breakfast" }) as HTMLInputElement;
  const active = h("input", { type: "checkbox", checked: m ? m.active : true }) as HTMLInputElement;
  const start = h("input", { type: "time", value: m?.start_min != null ? fmtMin(m.start_min) : "" }) as HTMLInputElement;
  const end = h("input", { type: "time", value: m?.end_min != null ? fmtMin(m.end_min) : "" }) as HTMLInputElement;
  const body = h("div", { class: "rm-form" },
    field("Menu name", name),
    h("div", { class: "rm-form-grid" }, field("Serves from", start), field("Serves until", end)),
    h("p", { class: "bv-muted rm-hint" }, "Leave times blank for an always-on menu. When a time window is set, that menu auto-shows during those hours."),
    h("label", { class: "rm-check" }, active, " Active"));
  const save = async () => {
    if (!name.value.trim()) { toast("Name is required", "warning"); return; }
    const payload = { name: name.value, active: active.checked, start_min: start.value ? toMin(start.value) : null, end_min: end.value ? toMin(end.value) : null };
    try { if (m) await bvApi(`/api/menus/${m.id}`, { method: "PATCH", body: JSON.stringify(payload) }); else await bvApi("/api/menus", { method: "POST", body: JSON.stringify(payload) }); flash(m ? "Saved" : "Menu added", "success"); shell.select("settings"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: m ? "Edit menu" : "New menu", body, actions: [{ label: m ? "Save" : "Add", primary: true, onClick: () => { void save(); } }] });
}

function fmtMin(m: number | null): string { if (m == null) return ""; const hh = Math.floor(m / 60), mm = m % 60; return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; }
function toMin(s: string): number { const [hh, mm] = s.split(":").map(Number); return (hh || 0) * 60 + (mm || 0); }
function field(label: string, el: HTMLElement) { return h("label", { class: "rm-field" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Restaurant Menu couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
