// Hýsa Partner Referrals — Cloudflare worker.
// Pages in /public are static assets; this worker handles /go links, tracking, forms and the admin/job API.
import { uid, randKey, nowISO, today, commission, agrLabel, defaultSettings, slugify, withParams, publicPartner, agreementActive, CATEGORIES, SYSTEMS, diffChanges, logChanges, partnerHealth, benefit, benefitLabel, cashbackAmount, cashbackState, AGR, exVat, saleCommission, codeFor, guestOfferText, benefitAmount, voucherEmail, cashbackAckEmail, signupNoticeEmail, welcomeEmail } from "../public/assets/lib.js";
import { WorkerMailer } from "./mailer.js";

const JSONH = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { ...JSONH, ...extra } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const emailOk = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* ---------- email straight from the site (guests should not wait for the hourly job) ----------
   Uses the same SMTP account as the hourly job (Cloudflare secrets SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS).
   If sending fails or SMTP is not set up, nothing breaks: the hourly job sends the email instead. */
async function sendMail(env, st, { to, subject, text, bcc }) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !to) return false;
  const port = +(env.SMTP_PORT || 465);
  try {
    const m = await WorkerMailer.connect({ host: env.SMTP_HOST, port, secure: port === 465, startTls: port === 587, credentials: { username: env.SMTP_USER, password: env.SMTP_PASS }, authType: ["plain", "login"], socketTimeoutMs: 15000, responseTimeoutMs: 15000 });
    await m.send({ from: { name: st.company || "Hýsa", email: env.SMTP_USER }, reply: st.invoiceEmail || env.SMTP_USER, to, subject, text });
    await m.close?.();
    return true;
  } catch (e) { console.error("mail failed", e?.message || e); return false; }
}

/* ---------- storage ---------- */
async function all(env, kind) {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE kind = ?").bind(kind).all();
  return r.results.map((x) => JSON.parse(x.data));
}
async function one(env, kind, id) {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE kind = ? AND id = ?").bind(kind, id).first();
  return r ? JSON.parse(r.data) : null;
}
function putStmt(env, kind, doc) {
  doc.updatedAt = doc.updatedAt || nowISO();
  return env.DB.prepare(
    "INSERT INTO docs (kind, id, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE excluded.updated_at >= docs.updated_at"
  ).bind(kind, doc.id, JSON.stringify(doc), doc.updatedAt);
}
const put = (env, kind, doc) => putStmt(env, kind, doc).run();
async function settings(env) { return { ...defaultSettings(), ...((await one(env, "settings", "main")) || {}) }; }
async function partnerBy(env, field, value) { return (await all(env, "partner")).find((p) => p[field] === value && !p.deleted) || null; }

/* ---------- admin session (signed cookie) ---------- */
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${env.ADMIN_PASSWORD}|${env.JOB_KEY}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return btoa(String.fromCharCode(...sig)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
}
async function isAdmin(req, env) {
  const c = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)hs=([^;]+)/);
  if (!c) return false;
  const [exp, sig] = decodeURIComponent(c[1]).split(".");
  return +exp > Date.now() && sig === (await hmac(env, exp));
}
function timingSafeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const isJob = (req, env) => !!env.JOB_KEY && timingSafeEq(req.headers.get("Authorization") || "", `Bearer ${env.JOB_KEY}`);

/* ---------- sales helpers ---------- */
// In-person amounts (and amounts read from the partner's thank-you page) are what the guest paid, incl. VAT.
// The commission is always calculated on the amount excl. VAT.
let VAT = 25;
function newSale(partner, f, source, extra = {}) {
  const ts = nowISO();
  const amount = Math.max(0, +f.amount || 0), persons = Math.max(1, +f.persons || 1);
  const vatIncluded = ["partner", "guest", "voucher", "script"].includes(source);
  // A Hýsa guest discount given at the till: the amount is what the guest paid after the discount (% or a fixed kr amount)
  const disc = extra.discount || null; delete extra.discount;
  const pct = disc && disc.kind !== "fixed" ? Math.min(90, Math.max(0, +disc.rate || 0)) / 100 : 0, fixedOff = disc && disc.kind === "fixed" ? Math.max(0, +disc.rate || 0) : 0;
  const d = pct || fixedOff;
  const full = pct ? amount / (1 - pct) : amount + fixedOff;
  const amountExVat = Math.round((vatIncluded ? exVat(full, VAT) : full) * 100) / 100;
  const c = saleCommission(partner, { baseExVat: amountExVat, persons, discountExVat: d ? (vatIncluded ? exVat(full - amount, VAT) : full - amount) : 0 });
  return {
    id: uid("s_"), partnerId: partner.id, date: clean(f.date, 10) || today(), amount, persons, currency: partner.currency || "DKK",
    orderRef: clean(f.orderRef, 80), guestName: clean(f.guestName, 120), guestEmail: clean(f.guestEmail, 160), guestPhone: clean(f.guestPhone, 40),
    notes: clean(f.notes, 500), source, method: ["partner", "guest"].includes(source) ? "in-store" : "online",
    vatIncluded, amountExVat, ...(d ? { fullPrice: Math.round(full * 100) / 100, discountGiven: Math.round((full - amount) * 100) / 100 } : {}), kickback: c.kickback, guestDiscount: c.guestDiscount, commission: c.commission, rateLabel: agrLabel(partner), status: "open", review: "approved",
    partnerReported: source === "partner", guestReceiptId: null, notifiedAt: source === "partner" ? ts : null,
    createdAt: ts, updatedAt: ts, ...extra,
  };
}
// A guest receipt and a partner report for the same purchase: same partner, amount within 2%, date within 3 days.
function sameSale(a, b) {
  const da = Math.abs(new Date(a.date) - new Date(b.date)) / 864e5;
  const tol = Math.max(1, 0.02 * Math.max(+a.amount, +b.amount));
  return a.partnerId === b.partnerId && da <= 3 && Math.abs(+a.amount - +b.amount) <= tol;
}

/* ---------- tracking script served to partner websites ---------- */
function trackingScript(origin, days) {
  return `/* Hýsa referral tracking */
(function(){
  var API=${JSON.stringify(origin + "/api/conversion")},K="hysa_click",D=${+days || 30};
  var s=document.currentScript,P=s&&s.getAttribute("data-partner");
  try{if(P){var SK="hysa_seen",st=+localStorage.getItem(SK)||0;if(Date.now()-st>864e5){localStorage.setItem(SK,String(Date.now()));new Image().src=${JSON.stringify(origin + "/api/seen?k=")}+encodeURIComponent(P)}}}catch(e){}
  function save(v){try{localStorage.setItem(K,JSON.stringify({id:v,t:Date.now()}))}catch(e){}document.cookie=K+"="+encodeURIComponent(v)+";max-age="+(D*86400)+";path=/;SameSite=Lax"}
  function get(){try{var o=JSON.parse(localStorage.getItem(K)||"null");if(o&&Date.now()-o.t<D*864e5)return o.id}catch(e){}var m=document.cookie.match(/(?:^|; )hysa_click=([^;]+)/);return m?decodeURIComponent(m[1]):null}
  var m=location.search.match(/[?&]hysa_click=([^&#]+)/);if(m)save(decodeURIComponent(m[1]));
  window.hysaConversion=function(o){o=o||{};var c=get();if(!c||!P)return false;
    var body=JSON.stringify({partner:P,click:c,orderId:String(o.orderId||""),amount:+o.amount||0,currency:o.currency||"",persons:+o.persons||1});
    if(navigator.sendBeacon&&navigator.sendBeacon(API,body))return true;
    try{fetch(API,{method:"POST",body:body,keepalive:true,mode:"no-cors"})}catch(e){}return true};
  var q=window.hysaQueue;if(q&&q.length)for(var i=0;i<q.length;i++)window.hysaConversion(q[i]);
  var c=get();if(!c)return;
  /* Shopify: write the Hýsa mark onto the cart so it is saved on the order */
  if(window.Shopify&&window.fetch){try{if(sessionStorage.getItem("hysa_cart")!==c){fetch("/cart/update.js",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({attributes:{hysa_click:c}})}).then(function(){try{sessionStorage.setItem("hysa_cart",c)}catch(e){}})}}catch(e){}}
  /* WooCommerce: report the order on the order-received page */
  var w=location.pathname.match(/order-received[/]([0-9]+)/);
  if(w){var report=function(){var el=document.querySelector(".woocommerce-order-overview__total .amount, .order_details tfoot tr:last-child .amount, .woocommerce-table--order-details tfoot tr:last-child .amount");
    var t=el?el.textContent.replace(/[^0-9,.]/g,"").replace(/^[.,]+/,""):"",d=Math.max(t.lastIndexOf(","),t.lastIndexOf("."));
    var amt=t?(d>-1&&t.length-d-1<=2?parseFloat(t.slice(0,d).replace(/[,.]/g,"")+"."+t.slice(d+1)):parseFloat(t.replace(/[,.]/g,""))):0;
    window.hysaConversion({orderId:w[1],amount:amt||0});};
    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",report);else report();}
})();`;
}

async function voucherCode(env) {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(5));
    const code = "HY-" + [...b].map((x) => a[x % a.length]).join("");
    if (!(await one(env, "voucher", code))) return code;
  }
}
function voucherState(v, s) {
  if (!v || v.deleted) return { ok: false, reason: "This code does not exist. Check the letters and try again." };
  if (v.expiresAt && v.expiresAt < nowISO()) return { ok: false, reason: `This voucher expired on ${v.expiresAt.slice(0, 10)}.` };
  const max = +s.voucherUses || 0;
  if (max && (v.uses || []).length >= max) return { ok: false, reason: "This voucher has already been used." };
  return { ok: true };
}

/* ---------- router ---------- */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    try {
      // Click-through link: /go/<partner-slug>
      if (path.startsWith("/go/")) {
        const slug = decodeURIComponent(path.slice(4)).replace(/\/$/, "");
        const p = await partnerBy(env, "slug", slug);
        if (!p || !agreementActive(p) || !p.website) return Response.redirect(url.origin + "/", 302);
        const click = randKey(12);
        await env.DB.prepare("INSERT INTO clicks (id, partner_id, ts, ua, referer) VALUES (?, ?, ?, ?, ?)")
          .bind(click, p.id, nowISO(), clean(req.headers.get("User-Agent"), 200), clean(req.headers.get("Referer"), 200)).run();
        const target = withParams(p.website, { hysa_click: click, ref: "hysa", utm_source: "hysa", utm_medium: "guest_guide", utm_campaign: p.slug });
        return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer-when-downgrade" } });
      }
      if (path === "/t.js") {
        const s = await settings(env);
        return new Response(trackingScript(url.origin, s.cookieDays), { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" } });
      }

      if (path.startsWith("/api/")) {
        if (method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET", "Access-Control-Allow-Headers": "Content-Type" } });
        if (path === "/api/seen" && method === "GET") {
          const k = (url.searchParams.get("k") || "").slice(0, 40);
          const p = k && (await partnerBy(env, "trackKey", k));
          if (p && (!p.scriptSeenAt || Date.now() - Date.parse(p.scriptSeenAt) > 12 * 36e5)) { p.scriptSeenAt = nowISO(); p.updatedAt = nowISO(); await put(env, "partner", p); }
          return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
        }
        return await api(req, env, url, path, method, ctx);
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return path.startsWith("/api/") ? bad("Something went wrong on our side. Please try again.", 500) : new Response("Error", { status: 500 });
    }
  },
};

async function body(req) { try { return JSON.parse(await req.text()); } catch { return {}; } }

async function api(req, env, url, path, method, ctx) {
  const later = (p) => { try { ctx?.waitUntil ? ctx.waitUntil(p) : p.catch(() => {}); } catch (_) {} };
  if (method === "POST") VAT = +(await settings(env)).vatRate || 25;
  /* ---- public ---- */
  if (path === "/api/public" && method === "GET") {
    const s = await settings(env);
    const partners = (await all(env, "partner")).filter((p) => agreementActive(p) && p.showOnGuide !== false).map(publicPartner)
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return json({ company: s.company, partners, categories: CATEGORIES, systems: SYSTEMS, defaultRate: s.defaultRate, invoiceFrequency: s.invoiceFrequency || "weekly", paymentDays: s.paymentDays, receiptReviewDays: s.receiptReviewDays || 3 });
  }

  // Conversion from the tracking script on a partner's website
  if (path === "/api/conversion" && method === "POST") {
    const b = await body(req);
    const cors = { "Access-Control-Allow-Origin": "*" };
    const p = await partnerBy(env, "trackKey", clean(b.partner, 60));
    if (!p) return json({ ok: false }, 200, cors);
    const click = await env.DB.prepare("SELECT id, ts FROM clicks WHERE id = ? AND partner_id = ?").bind(clean(b.click, 40), p.id).first();
    const s = await settings(env);
    if (!click || Date.now() - new Date(click.ts) > (+s.cookieDays || 30) * 864e5) return json({ ok: false }, 200, cors);
    const orderRef = clean(b.orderId, 80);
    const extId = `script:${p.id}:${orderRef || click.id}`;
    if ((await all(env, "sale")).some((x) => x.extId === extId && !x.deleted)) return json({ ok: true, duplicate: true }, 200, cors);
    const sale = newSale(p, { amount: b.amount, persons: b.persons, orderRef, date: today() }, "script", { extId, clickId: click.id, matchedBy: "Hýsa link" });
    if (b.currency) sale.currency = clean(b.currency, 3).toUpperCase();
    p.lastConversionAt = nowISO(); p.updatedAt = nowISO();
    await env.DB.batch([putStmt(env, "sale", sale), putStmt(env, "partner", p)]);
    return json({ ok: true }, 200, cors);
  }

  // Guest gets a personal voucher for an in-person offer
  if (path === "/api/voucher" && method === "POST") {
    const b = await body(req);
    const p = await one(env, "partner", clean(b.partnerId, 60));
    if (!p || !agreementActive(p) || benefit(p).mode !== "discount" || !(benefit(p).rate > 0)) return bad("This offer is not available right now.");
    const name = clean(b.guestName, 120), email = clean(b.guestEmail, 160).toLowerCase();
    if (!name || !email || !emailOk(email)) return bad("Please enter your name and a valid email.");
    const s = await settings(env);
    const existing = (await all(env, "voucher")).find((v) => v.partnerId === p.id && v.guestEmail === email && voucherState(v, s).ok);
    const v = existing || {
      id: await voucherCode(env), partnerId: p.id, guestName: name, guestEmail: email, guestPhone: clean(b.guestPhone, 40), stay: clean(b.stay, 120),
      offer: guestOfferText(p), expiresAt: new Date(Date.now() + (+s.voucherDays || 7) * 864e5).toISOString(), uses: [], confirmKey: randKey(24), createdAt: nowISO(), updatedAt: nowISO(),
    };
    if (!existing) {
      await put(env, "voucher", v);
      later((async () => { if (await sendMail(env, s, { to: v.guestEmail, ...(({ subject, body }) => ({ subject, text: body }))(voucherEmail(v, p, s)) })) { const cur = await one(env, "voucher", v.id); if (cur && !cur.emailedAt) { cur.emailedAt = nowISO(); cur.updatedAt = nowISO(); await put(env, "voucher", cur); } } })());
    }
    return json({ ok: true, code: v.id, partner: p.name, offer: v.offer, expiresAt: v.expiresAt, guestName: v.guestName, address: p.address || "" });
  }

  // Guest follow-up: "Did you use your voucher?"
  const cm = path.match(/^\/api\/confirm\/([A-Za-z0-9]{20,40})$/);
  if (cm) {
    const v = (await all(env, "voucher")).find((x) => x.confirmKey === cm[1] && !x.deleted);
    if (!v) return bad("This link is not valid.", 404);
    const p = await one(env, "partner", v.partnerId);
    if (method === "GET") return json({ partner: p?.name || "", offer: v.offer, guestName: v.guestName, code: v.id, createdAt: v.createdAt, answered: v.guestAnswer || null, registered: (v.uses || []).length > 0 });
    if (method === "POST") {
      const b = await body(req);
      const ts = nowISO();
      if (b.visited === false) {
        v.guestAnswer = { visited: false, at: ts }; v.updatedAt = ts;
        await put(env, "voucher", v);
        return json({ ok: true });
      }
      const amount = +b.amount;
      if (!(amount > 0)) return bad("Please enter the amount you paid.");
      let fileId = null;
      const img = String(b.image || "");
      if (img) {
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 1_400_000) return bad("The photo could not be used. Please try another one.");
        fileId = uid("f_");
        await env.DB.prepare("INSERT INTO files (id, mime, data, created_at) VALUES (?, ?, ?, ?)").bind(fileId, img.slice(5, img.indexOf(";")), img, ts).run();
      }
      v.guestAnswer = { visited: true, amount, date: clean(b.date, 10) || today(), fileId, at: ts };
      const stmts = [];
      if (!(v.uses || []).length && p) {
        // The partner did not register it: create the sale from the guest's confirmation and flag it
        const sale = newSale(p, { date: v.guestAnswer.date, amount, guestName: v.guestName, guestEmail: v.guestEmail, guestPhone: v.guestPhone, notes: "Confirmed by the guest. The partner did not register this voucher." }, "guest",
          { voucherId: v.id, guestReceiptId: fileId, guestConfirmed: true, flagged: "not_registered", review: "approved" });
        v.guestSaleId = sale.id;
        stmts.push(putStmt(env, "sale", sale));
      }
      v.updatedAt = ts;
      stmts.push(putStmt(env, "voucher", v));
      await env.DB.batch(stmts);
      return json({ ok: true });
    }
  }

  // Partner signs up
  if (path === "/api/signup" && method === "POST") {
    const b = await body(req);
    const s = await settings(env);
    const name = clean(b.name, 120), email = clean(b.email, 160);
    if (!name || !email) return bad("Please fill in the business name and your email.");
    if (!emailOk(email) || !emailOk(clean(b.invoiceEmail, 160))) return bad("Please check the email address.");
    if (!b.acceptTerms) return bad("Please accept the partner terms.");
    const existing = await all(env, "partner");
    let slug = slugify(name), n = 2;
    while (existing.some((p) => p.slug === slug)) slug = `${slugify(name)}-${n++}`;
    const system = SYSTEMS[b.system] ? b.system : "none";
    const ts = nowISO();
    const p = {
      id: uid("p_"), slug, status: "pending", active: true, showOnGuide: true, autoInvoice: true,
      name, category: CATEGORIES.includes(b.category) ? b.category : "Other", currency: "DKK",
      website: clean(b.website, 300), phone: clean(b.phone, 40), publicEmail: clean(b.publicEmail, 160), address: clean(b.address, 200), hours: clean(b.hours, 120),
      description: clean(b.description, 600),
      contactName: clean(b.contactName, 120), email, invoiceEmail: clean(b.invoiceEmail, 160), companyId: clean(b.companyId, 40),
      offer: { type: AGR[b.offerType] ? b.offerType : "percent", rate: +b.offerRate > 0 ? Math.round(+b.offerRate * 100) / 100 : +s.defaultRate || 10, notes: clean(b.offerNotes, 300) },
      agreement: { type: AGR[b.offerType] ? b.offerType : "percent", rate: +b.offerRate > 0 ? Math.round(+b.offerRate * 100) / 100 : +s.defaultRate || 10, validFrom: today(), validTo: "", notes: "" },
      integration: { type: system, shop: clean(b.shop, 200), token: clean(b.token, 200), url: clean(b.shopUrl, 300), key: clean(b.key, 200), secret: clean(b.secret, 200) },
      trackKey: randKey(20), portalKey: randKey(28), signupAt: ts, adminNotifiedAt: null, welcomeSentAt: null, createdAt: ts, updatedAt: ts,
    };
    await put(env, "partner", p);
    later((async () => { const n = signupNoticeEmail(p, url.origin); if (await sendMail(env, s, { to: s.notifyEmail || s.invoiceEmail, subject: n.subject, text: n.body })) { const cur = await one(env, "partner", p.id); if (cur && !cur.adminNotifiedAt) { cur.adminNotifiedAt = nowISO(); await put(env, "partner", cur); } } })());
    return json({ ok: true, portalKey: p.portalKey });
  }

  // Guest uploads a receipt for an in-person purchase
  if (path === "/api/receipt" && method === "POST") {
    const b = await body(req);
    const p = await one(env, "partner", clean(b.partnerId, 60));
    if (!p || p.status !== "approved") return bad("Please choose where you bought something.");
    const amount = +b.amount;
    if (!(amount > 0)) return bad("Please enter the amount you paid.");
    if (!clean(b.guestName) || !emailOk(clean(b.guestEmail))) return bad("Please enter your name and a valid email.");
    const img = String(b.image || "");
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 1_400_000) return bad("Please add a photo of your receipt (max 1 MB).");
    const ts = nowISO(), fileId = uid("f_");
    await env.DB.prepare("INSERT INTO files (id, mime, data, created_at) VALUES (?, ?, ?, ?)").bind(fileId, img.slice(5, img.indexOf(";")), img, ts).run();
    const f = { date: clean(b.date, 10) || today(), amount, guestName: b.guestName, guestEmail: b.guestEmail, guestPhone: b.guestPhone, orderRef: b.orderRef, notes: b.stay ? `Stay: ${clean(b.stay, 120)}` : "" };
    const sales = await all(env, "sale");
    const email = clean(b.guestEmail, 160).toLowerCase();
    if (sales.some((x) => !x.deleted && x.guestReceiptId && (x.guestEmail || "").toLowerCase() === email && sameSale(x, { ...f, partnerId: p.id }))) return bad("We already have this receipt. Thank you!");
    const cb = cashbackAmount(p, amount);
    const cashback = cb > 0 ? { rate: benefit(p).rate, kind: benefit(p).kind, amount: cb, currency: p.currency || "DKK", createdAt: ts } : null;
    const match = sales.find((x) => !x.deleted && ["partner", "voucher"].includes(x.source) && !x.guestReceiptId && sameSale(x, { ...f, partnerId: p.id }));
    if (match) {
      Object.assign(match, { guestReceiptId: fileId, guestConfirmed: true, guestName: match.guestName || clean(b.guestName, 120), guestEmail: match.guestEmail || email, guestPhone: match.guestPhone || clean(b.guestPhone, 40), updatedAt: ts });
      if (cashback && !match.cashback) match.cashback = { ...cashback, amount: cashbackAmount(p, match.amount) };
      await put(env, "sale", match);
    } else {
      await put(env, "sale", newSale(p, { ...f, guestEmail: email }, "guest", { review: "pending", guestReceiptId: fileId, guestConfirmed: true, cashback }));
    }
    const saved = match || (await all(env, "sale")).find((x) => x.guestReceiptId === fileId);
    const rs = await settings(env);
    if (saved?.cashback && !saved.cashback.ackAt) later((async () => { const m = cashbackAckEmail(saved, p, rs); if (await sendMail(env, rs, { to: saved.guestEmail, subject: m.subject, text: m.body })) { const cur = await one(env, "sale", saved.id); if (cur?.cashback && !cur.cashback.ackAt) { cur.cashback.ackAt = nowISO(); cur.updatedAt = nowISO(); await put(env, "sale", cur); } } })());
    return json({ ok: true, cashback: match?.cashback?.amount ?? cb, currency: p.currency || "DKK" });
  }

  /* ---- partner portal (secret link) ---- */
  const pm = path.match(/^\/api\/partner\/([A-Za-z0-9]{20,40})(\/[a-z-]+(?:\/HY-[A-Z0-9]{5}|\/f_[a-z0-9]{6,30})?)?$/);
  if (pm) {
    const p = await partnerBy(env, "portalKey", pm[1]);
    if (!p) return bad("This partner link is not valid.", 404);
    const action = pm[2] || "";
    if (action === "" && method === "GET") {
      const [sales, invoices, s] = await Promise.all([all(env, "sale"), all(env, "invoice"), settings(env)]);
      const clicks = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS m FROM clicks WHERE partner_id = ?").bind(new Date(Date.now() - 30 * 864e5).toISOString(), p.id).first();
      const { token, secret, key, ...integ } = p.integration || {};
      return json({
        company: s.company, origin: url.origin, cookieDays: s.cookieDays, paymentDays: s.paymentDays, vatRate: s.vatRate,
        partner: { ...publicPartner(p), discountText: p.discountText || "", discountCode: p.discountCode || "", status: p.status, contactName: p.contactName, contactEmail: p.email, invoiceEmail: p.invoiceEmail, companyId: p.companyId, agreement: p.agreement, agreementLabel: agrLabel(p), trackKey: p.trackKey, integration: { ...integ, connected: !!(token || key) } },
        todo: partnerHealth(p, { sales, invoices }).issues.filter((x) => x.who === "partner").map((x) => x.text),
        deal: { pays: agrLabel(p), guests: benefitLabel(p), mode: benefit(p).mode, rate: benefit(p).rate, kind: benefit(p).kind, amount: benefitAmount(p), code: codeFor(p), frequency: p.invoiceFrequency || s.invoiceFrequency || "weekly", reviewDays: +s.receiptReviewDays || 3 },
        clicks: { total: clicks?.n || 0, last30: clicks?.m || 0 },
        sales: sales.filter((x) => x.partnerId === p.id && !x.deleted && x.review !== "rejected").map(({ guestEmail, guestPhone, ...x }) => x).sort((a, b) => (b.date || "").localeCompare(a.date || "")),
        invoices: invoices.filter((x) => x.partnerId === p.id && !x.deleted).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")),
      });
    }
    const vm = action.match(/^\/voucher\/(HY-[A-Z0-9]{5})$/);
    if (vm && method === "GET") {
      const v = await one(env, "voucher", vm[1]);
      const st = voucherState(v, await settings(env));
      if (v && v.partnerId !== p.id) return json({ ok: false, reason: "This voucher is for another business." });
      if (!st.ok) return json(st);
      return json({ ok: true, guestName: v.guestName, offer: v.offer || guestOfferText(p), expiresAt: v.expiresAt, usedBefore: (v.uses || []).length });
    }
    if (action === "/redeem" && method === "POST") {
      if (p.status !== "approved") return bad("Your partnership is not approved yet.");
      const b = await body(req);
      const code = clean(b.code, 12).toUpperCase().replace(/^HY(?!-)/, "HY-");
      const v = await one(env, "voucher", code);
      const s = await settings(env);
      if (v && v.partnerId !== p.id) return bad("This voucher is for another business.");
      const st = voucherState(v, s);
      if (!st.ok) return bad(st.reason);
      if (!(+b.amount > 0)) return bad("Please enter the amount the guest pays.");
      const sale = newSale(p, { date: today(), amount: +b.amount, persons: b.persons, orderRef: b.orderRef, guestName: v.guestName, guestEmail: v.guestEmail, guestPhone: v.guestPhone }, "voucher", { voucherId: v.id, partnerReported: true, notifiedAt: nowISO(), discount: benefit(p).mode === "discount" ? benefit(p) : null });
      // Guest already confirmed it and a flagged sale exists: replace that one instead of counting twice
      if (v.guestSaleId) {
        const prev = await one(env, "sale", v.guestSaleId);
        if (prev && !prev.deleted && (!prev.status || prev.status === "open")) { sale.id = prev.id; sale.createdAt = prev.createdAt; sale.guestReceiptId = prev.guestReceiptId; sale.guestConfirmed = true; }
        v.guestSaleId = null;
      }
      v.uses = [...(v.uses || []), { saleId: sale.id, at: nowISO(), amount: sale.amount }]; v.updatedAt = nowISO();
      await env.DB.batch([putStmt(env, "sale", sale), putStmt(env, "voucher", v)]);
      return json({ ok: true, guestName: v.guestName, commission: sale.commission });
    }
    if (action === "/sale" && method === "POST") {
      if (p.status !== "approved") return bad("Your partnership is not approved yet.");
      const b = await body(req);
      if (!(+b.amount > 0)) return bad("Please enter the amount.");
      const f = { date: clean(b.date, 10) || today(), amount: +b.amount, persons: b.persons, orderRef: b.orderRef, guestName: b.guestName, notes: b.notes };
      const sales = await all(env, "sale");
      const pending = sales.find((x) => !x.deleted && x.source === "guest" && x.review === "pending" && sameSale(x, { ...f, partnerId: p.id }));
      if (pending) {
        Object.assign(pending, { review: "approved", partnerReported: true, orderRef: pending.orderRef || clean(b.orderRef, 80), notifiedAt: nowISO(), updatedAt: nowISO() });
        await put(env, "sale", pending);
        return json({ ok: true, matchedGuestReceipt: true });
      }
      await put(env, "sale", newSale(p, f, "partner"));
      return json({ ok: true });
    }
    const fm = action.match(/^\/file\/(f_[a-z0-9]{6,30})$/);
    if (fm && method === "GET") {
      if (!(await all(env, "sale")).some((x) => x.partnerId === p.id && !x.deleted && x.guestReceiptId === fm[1])) return bad("Not found", 404);
      const f = await env.DB.prepare("SELECT mime, data FROM files WHERE id = ?").bind(fm[1]).first();
      if (!f) return bad("Not found", 404);
      const bin = Uint8Array.from(atob(f.data.slice(f.data.indexOf(",") + 1)), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { "Content-Type": f.mime, "Cache-Control": "private, max-age=86400" } });
    }
    if ((action === "/receipt-ok" || action === "/dispute") && method === "POST") {
      const b = await body(req);
      const sale = await one(env, "sale", clean(b.saleId, 60));
      if (!sale || sale.partnerId !== p.id || sale.deleted || sale.source !== "guest") return bad("Receipt not found.", 404);
      if (sale.review !== "pending") return bad("This receipt has already been handled.");
      if (action === "/receipt-ok") Object.assign(sale, { review: "approved", partnerReported: true, partnerCheckedAt: nowISO() });
      else {
        const reason = clean(b.reason, 300);
        if (!reason) return bad("Please tell us why the receipt is wrong.");
        Object.assign(sale, { review: "disputed", disputeReason: reason, disputedAt: nowISO(), adminNotifiedAt: null });
      }
      sale.updatedAt = nowISO();
      await put(env, "sale", sale);
      return json({ ok: true });
    }
    if (action === "/update" && method === "POST") {
      const b = await body(req);
      const before = { ...p }, oldI = { ...(p.integration || {}) };
      for (const k of ["phone", "publicEmail", "address", "hours", "description", "website", "contactName", "invoiceEmail"]) if (k in b) p[k] = clean(b[k], k === "description" ? 600 : 300);
      if (b.integration) {
        const i = b.integration, cur = p.integration || {};
        p.integration = { ...cur, type: SYSTEMS[i.type] ? i.type : cur.type, shop: clean(i.shop ?? cur.shop, 200), url: clean(i.url ?? cur.url, 300),
          token: i.token ? clean(i.token, 200) : cur.token, key: i.key ? clean(i.key, 200) : cur.key, secret: i.secret ? clean(i.secret, 200) : cur.secret, lastError: "" };
      }
      const ch = diffChanges(before, p, "partner");
      const ni = p.integration || {};
      if (b.integration && (ni.type !== oldI.type || ni.url !== oldI.url || ni.shop !== oldI.shop || ni.key !== oldI.key || ni.token !== oldI.token || ni.secret !== oldI.secret))
        ch.push({ at: nowISO(), by: "partner", field: "integration", label: "Online bookings", from: SYSTEMS[oldI.type] || "", to: (SYSTEMS[ni.type] || "") + (ni.key !== oldI.key || ni.token !== oldI.token || ni.secret !== oldI.secret ? " (new access key)" : "") });
      logChanges(p, ch);
      p.updatedAt = nowISO();
      await put(env, "partner", p);
      return json({ ok: true });
    }
    return bad("Not found", 404);
  }

  /* ---- admin ---- */
  if (path === "/api/admin/login" && method === "POST") {
    const b = await body(req);
    if (!env.ADMIN_PASSWORD || !timingSafeEq(String(b.password || ""), env.ADMIN_PASSWORD)) { await new Promise((r) => setTimeout(r, 600)); return bad("Wrong password.", 401); }
    const exp = String(Date.now() + 30 * 864e5);
    return json({ ok: true }, 200, { "Set-Cookie": `hs=${encodeURIComponent(exp + "." + (await hmac(env, exp)))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}` });
  }
  if (path === "/api/admin/logout") return json({ ok: true }, 200, { "Set-Cookie": "hs=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });

  const admin = path.startsWith("/api/admin/") && (await isAdmin(req, env));
  const job = path.startsWith("/api/job/") && isJob(req, env);
  if (path.startsWith("/api/admin/") && !admin) return bad("Please log in.", 401);
  if (path.startsWith("/api/job/") && !job) return bad("Unauthorized", 401);

  if ((path === "/api/admin/data" || path === "/api/job/data") && method === "GET") {
    const [partners, sales, invoices, vouchers, s] = await Promise.all([all(env, "partner"), all(env, "sale"), all(env, "invoice"), all(env, "voucher"), settings(env)]);
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const cs = await env.DB.prepare("SELECT partner_id AS p, COUNT(*) AS n, SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS m FROM clicks GROUP BY partner_id").bind(since).all();
    const clickStats = Object.fromEntries(cs.results.map((r) => [r.p, { total: r.n, last30: r.m }]));
    const sync = (await one(env, "meta", "sync")) || { lastRun: null, log: [] };
    return json({ origin: url.origin, settings: s, partners, sales, invoices, vouchers, clickStats, sync });
  }
  if ((path === "/api/admin/upsert" || path === "/api/job/upsert") && method === "POST") {
    const b = await body(req);
    const docs = Array.isArray(b.docs) ? b.docs.slice(0, 500) : [];
    const kinds = ["partner", "sale", "invoice", "voucher", "settings", "meta"];
    const stmts = [];
    const fromAdmin = path === "/api/admin/upsert";
    const KEEP = { partner: ["welcomeSentAt", "adminNotifiedAt", "scriptSeenAt", "lastAutoInvoice", "lastConversionAt"], voucher: ["emailedAt", "followUpSentAt"], sale: ["notifiedAt"] };
    const welcome = [];
    for (const d of docs) {
      if (!kinds.includes(d.kind) || !d.doc?.id) continue;
      if (fromAdmin && KEEP[d.kind]) {
        const cur = await one(env, d.kind, d.doc.id);
        if (cur) {
          for (const k of KEEP[d.kind]) if (!d.doc[k] && cur[k]) d.doc[k] = cur[k];
          if (d.kind === "partner" && cur.integration) for (const k of ["lastSync", "lastError"]) if (d.doc.integration && d.doc.integration[k] === undefined) d.doc.integration[k] = cur.integration[k];
          if (d.kind === "sale" && cur.cashback && d.doc.cashback) for (const k of ["ackAt", "paidAt", "paidEmailAt", "refundId", "frisbiiInvoice", "method"]) if (!d.doc.cashback[k] && cur.cashback[k] && !(k === "paidAt" && d.doc.cashback.method === "manual")) d.doc.cashback[k] = cur.cashback[k];
        }
        if (d.kind === "partner" && d.doc.status === "approved" && !d.doc.welcomeSentAt && d.doc.email && !d.doc.deleted) welcome.push(d.doc);
      }
      if (d.kind === "partner") { d.doc.slug = d.doc.slug || slugify(d.doc.name); d.doc.trackKey = d.doc.trackKey || randKey(20); d.doc.portalKey = d.doc.portalKey || randKey(28); }
      stmts.push(putStmt(env, d.kind, d.doc));
    }
    if (stmts.length) await env.DB.batch(stmts);
    if (welcome.length) {
      const st = await settings(env);
      for (const p of welcome) later((async () => { const m = welcomeEmail(p, st, url.origin); if (await sendMail(env, st, { to: p.email, subject: m.subject, text: m.body })) { const cur = await one(env, "partner", p.id); if (cur && !cur.welcomeSentAt) { cur.welcomeSentAt = nowISO(); await put(env, "partner", cur); } } })());
    }
    return json({ ok: true, saved: stmts.length });
  }
  if (path.startsWith("/api/admin/file/") && method === "GET") {
    const f = await env.DB.prepare("SELECT mime, data FROM files WHERE id = ?").bind(path.split("/").pop()).first();
    if (!f) return bad("Not found", 404);
    const bin = Uint8Array.from(atob(f.data.slice(f.data.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { "Content-Type": f.mime, "Cache-Control": "private, max-age=86400" } });
  }
  return bad("Not found", 404);
}
