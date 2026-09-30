// Hourly jobs, run by GitHub Actions (.github/workflows/jobs.yml):
// 1. fetch new orders from connected Shopify / WooCommerce shops that came through a Hýsa link or code
// 2. monthly invoices for the previous month
// 3. emails from hysa@hysa.fo: new sign-ups (to Hýsa), welcome (to approved partners), sale notifications, PDF invoices
import { commission, agrLabel, uid, randKey, nowISO, normRef, saleEmail, invoiceEmail, welcomeEmail, fmtMoney, createInvoice, billable, defaultSettings, SYSTEMS } from "../public/assets/lib.js";

const BASE = (process.env.WORKER_URL || "").replace(/\/$/, "");
const KEY = process.env.JOB_KEY;
if (!BASE || !KEY) throw new Error("WORKER_URL and JOB_KEY are required");
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const res = await fetch(`${BASE}/api/job/data`, { headers: H });
if (!res.ok) throw new Error(`Could not load data: ${res.status}`);
const data = await res.json();
const st = { ...defaultSettings(), ...data.settings };
const before = new Map();
data.vouchers = data.vouchers || [];
for (const [k, arr] of [["partner", data.partners], ["sale", data.sales], ["invoice", data.invoices], ["voucher", data.vouchers]]) for (const d of arr) before.set(`${k}:${d.id}`, JSON.stringify(d));
const log = [];
const say = (m) => { console.log(m); log.push(`${nowISO().slice(0, 16).replace("T", " ")} ${m}`); };
const touch = (o) => { o.updatedAt = nowISO(); return o; };

/* ---------- 1. online orders ---------- */
const DAY = 864e5;
const since = (p) => new Date(Math.max(p.integration?.lastSync ? new Date(p.integration.lastSync) - 2 * DAY : Date.now() - 30 * DAY, p.agreement?.validFrom ? new Date(p.agreement.validFrom).getTime() : 0)).toISOString();
const clickIn = (s) => (String(s || "").match(/[?&]hysa_click=([A-Za-z0-9]+)/) || [])[1] || "";
const viaHysa = (s) => /[?&](ref|utm_source)=hysa\b/i.test(String(s || "")) || !!clickIn(s);
const codeEq = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();

async function shopify(p, refs) {
  const shop = p.integration.shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  let url = `https://${shop}/admin/api/2024-10/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since(p))}`;
  const out = [];
  while (url) {
    const r = await fetch(url, { headers: { "X-Shopify-Access-Token": p.integration.token } });
    if (r.status === 401 || r.status === 403) throw new Error("Access refused – the token was removed or lacks read_orders");
    if (!r.ok) throw new Error(`Shopify answered ${r.status}`);
    const j = await r.json();
    for (const o of j.orders || []) {
      if (o.cancelled_at || o.test) continue;
      const code = (o.discount_codes || []).find((d) => codeEq(d.code, p.discountCode));
      const link = viaHysa(o.landing_site) || (o.note_attributes || []).some((n) => /hysa/i.test(`${n.name}${n.value}`));
      if (!code && !link && !refs.has(normRef(o.name || o.id))) continue;
      const refunded = (o.refunds || []).reduce((a, rf) => a + (rf.transactions || []).filter((t) => t.kind === "refund").reduce((b, t) => b + (+t.amount || 0), 0), 0);
      const c = o.customer || {};
      out.push({ extId: `shopify:${o.id}`, orderRef: o.name || String(o.id), date: o.created_at, amount: Math.max(0, (+o.current_subtotal_price || +o.subtotal_price || 0) - refunded), currency: o.currency,
        guestName: [c.first_name, c.last_name].filter(Boolean).join(" ") || o.billing_address?.name || "", guestEmail: o.email || c.email || "", guestPhone: o.phone || c.phone || "",
        clickId: clickIn(o.landing_site) || ((o.note_attributes || []).find((n) => n.name === "hysa_click") || {}).value || "", matchedBy: link ? "Hýsa link" : code ? `code ${code.code}` : "Hýsa link (returning guest)" });
    }
    const next = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}
async function woo(p, refs) {
  const base = p.integration.url.replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${p.integration.key}:${p.integration.secret}`).toString("base64");
  const out = [];
  for (let page = 1; page < 50; page++) {
    const r = await fetch(`${base}/wp-json/wc/v3/orders?per_page=100&page=${page}&after=${encodeURIComponent(since(p))}`, { headers: { Authorization: auth } });
    if (r.status === 401 || r.status === 403) throw new Error("Access refused – the API key was removed or is not Read");
    if (!r.ok) throw new Error(`WooCommerce answered ${r.status}`);
    const list = await r.json();
    for (const o of list) {
      if (!["processing", "completed", "on-hold"].includes(o.status)) continue;
      const code = (o.coupon_lines || []).find((c) => codeEq(c.code, p.discountCode));
      const m = Object.fromEntries((o.meta_data || []).map((x) => [x.key, String(x.value ?? "")]));
      const entry = m._wc_order_attribution_session_entry || "";
      const link = viaHysa(entry) || /hysa/i.test(m._wc_order_attribution_utm_source || "");
      if (!code && !link && !refs.has(normRef(o.number || o.id))) continue;
      const b = o.billing || {};
      out.push({ extId: `woo:${o.id}`, orderRef: String(o.number || o.id), date: o.date_created_gmt ? o.date_created_gmt + "Z" : o.date_created,
        amount: Math.max(0, (+o.total || 0) - (+o.total_tax || 0) - (+o.shipping_total || 0) - (o.refunds || []).reduce((a, x) => a + Math.abs(+x.total || 0), 0)), currency: o.currency,
        guestName: [b.first_name, b.last_name].filter(Boolean).join(" "), guestEmail: b.email || "", guestPhone: b.phone || "", clickId: clickIn(entry), matchedBy: link ? "Hýsa link" : code ? `code ${code.code}` : "Hýsa link (returning guest)" });
    }
    if (list.length < 100) break;
  }
  return out;
}
const known = new Set(data.sales.map((s) => s.extId).filter(Boolean));
let added = 0;
for (const p of data.partners) {
  const t = p.integration?.type;
  if (p.deleted || p.status !== "approved" || !["shopify", "woocommerce"].includes(t)) continue;
  if (t === "shopify" && !(p.integration.shop && p.integration.token)) continue;
  if (t === "woocommerce" && !(p.integration.url && p.integration.key)) continue;
  try {
    const refs = new Set(data.sales.filter((s) => !s.deleted && s.partnerId === p.id && s.source === "script").map((s) => normRef(s.orderRef)).filter(Boolean));
    const orders = t === "shopify" ? await shopify(p, refs) : await woo(p, refs);
    let n = 0;
    for (const o of orders) {
      if (known.has(o.extId)) continue;
      known.add(o.extId);
      // Already reported by the tracking code on the partner's website? Then use the exact amount from the shop instead of adding it twice.
      const dup = data.sales.find((s) => !s.deleted && s.partnerId === p.id && s.source === "script" && normRef(s.orderRef) && normRef(s.orderRef) === normRef(o.orderRef));
      if (dup) {
        if (dup.status === "open" || !dup.status) Object.assign(dup, { amount: o.amount, commission: commission(p, o.amount, dup.persons || 1), guestName: dup.guestName || o.guestName, guestEmail: dup.guestEmail || o.guestEmail, guestPhone: dup.guestPhone || o.guestPhone });
        Object.assign(dup, { extId: o.extId, source: t }); touch(dup);
        continue;
      }
      n++;
      const ts = nowISO();
      data.sales.push({ id: uid("s_"), partnerId: p.id, ...o, date: (o.date || ts).slice(0, 10), currency: o.currency || p.currency || "DKK", persons: 1, method: "online", source: t,
        commission: commission(p, o.amount, 1), rateLabel: agrLabel(p), status: "open", review: "approved", notifiedAt: null, createdAt: ts, updatedAt: ts });
    }
    Object.assign(p.integration, { lastSync: nowISO(), lastError: "" }); touch(p);
    added += n; if (n) say(`${p.name}: ${n} new order(s) via Hýsa`);
  } catch (e) {
    if (p.integration.lastError !== e.message) { p.integration.lastError = e.message; touch(p); }
    say(`${p.name}: ${e.message}`);
  }
}

/* ---------- 2. monthly invoices ---------- */
const now = new Date();
if (st.autoInvoice !== false && now.getUTCDate() >= (+st.invoiceDay || 1)) {
  const prevEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const month = prevEnd.toISOString().slice(0, 7), end = prevEnd.toISOString().slice(0, 10);
  for (const p of data.partners) {
    if (p.deleted || p.status !== "approved" || p.autoInvoice === false || p.lastAutoInvoice === month) continue;
    const open = data.sales.filter((s) => billable(s) && s.partnerId === p.id && (!s.status || s.status === "open") && (s.date || "") <= end);
    if (open.length) {
      const first = open.map((s) => s.date).sort()[0];
      const inv = createInvoice({ invoices: data.invoices, settings: st, partner: p, sales: open, from: first < `${month}-01` ? first : `${month}-01`, to: end, auto: true });
      say(`Invoice ${inv.number} for ${p.name}: ${fmtMoney(inv.total, inv.currency)}`);
    }
    p.lastAutoInvoice = month; touch(p);
  }
}

/* ---------- 3. emails ---------- */
async function invoicePDF(inv) {
  const PDFDocument = (await import("pdfkit")).default;
  const p = data.partners.find((x) => x.id === inv.partnerId) || {};
  const lines = data.sales.filter((s) => !s.deleted && s.invoiceId === inv.id).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = []; doc.on("data", (c) => chunks.push(c));
  const done = new Promise((r) => doc.on("end", () => r(Buffer.concat(chunks))));
  const green = "#1D6653", grey = "#5B6862";
  doc.fillColor(green).font("Helvetica-Bold").fontSize(20).text(st.company, 50, 50);
  doc.fillColor(grey).font("Helvetica").fontSize(9).text([st.address, st.companyId ? `Company no. / V-tal: ${st.companyId}` : "", st.invoiceEmail].filter(Boolean).join("\n"), 50, 76);
  doc.fillColor("#000").font("Helvetica-Bold").fontSize(16).text("INVOICE", 350, 50, { width: 195, align: "right" });
  doc.font("Helvetica").fontSize(9).text(`No. ${inv.number}\nDate ${inv.createdAt.slice(0, 10)}\nDue ${inv.dueDate}`, 350, 72, { width: 195, align: "right" });
  doc.font("Helvetica-Bold").fontSize(10).text("Bill to", 50, 140);
  doc.font("Helvetica").fontSize(10).text([p.name || inv.partnerName, p.companyId ? `Company no. ${p.companyId}` : "", p.address, inv.sendTo].filter(Boolean).join("\n"), 50, 154);
  doc.fontSize(10).text(`Referral commission for the period ${inv.from} to ${inv.to}`, 50, 222);
  doc.fillColor(grey).fontSize(9).text(`Agreement: ${agrLabel(p)}`, 50, 237);
  let y = 265;
  const cols = [[50, "Date", 70], [120, "Order / receipt", 110], [230, "How", 90], [320, "Purchase", 110, "right"], [435, "Commission", 110, "right"]];
  doc.rect(50, y - 4, 495, 18).fill("#E9EDE8"); doc.fillColor("#000").font("Helvetica-Bold").fontSize(9);
  cols.forEach(([x, t, w, a]) => doc.text(t, x + 4, y, { width: w - 8, align: a || "left" }));
  y += 20; doc.font("Helvetica").fontSize(9);
  for (const s of lines) {
    if (y > 740) { doc.addPage(); y = 50; }
    const row = [s.date, s.orderRef || "-", s.method === "in-store" ? "In person" : "Online", fmtMoney(s.amount, s.currency), fmtMoney(s.commission, s.currency)];
    cols.forEach(([x, , w, a], i) => doc.text(String(row[i]), x + 4, y, { width: w - 8, align: a || "left" }));
    y += 16; doc.moveTo(50, y - 3).lineTo(545, y - 3).strokeColor("#D5DBD3").lineWidth(0.5).stroke();
  }
  y += 8;
  [["Subtotal", fmtMoney(inv.net, inv.currency)], [`VAT ${inv.vatRate}%`, fmtMoney(inv.vat, inv.currency)], ["Total due", fmtMoney(inv.total, inv.currency)]].forEach(([k, v], i) => {
    doc.font(i === 2 ? "Helvetica-Bold" : "Helvetica").fontSize(i === 2 ? 11 : 9).text(k, 330, y, { width: 100 }).text(v, 435, y, { width: 106, align: "right" }); y += 16; });
  y += 20;
  const pay = [st.bankName, st.bankReg && st.bankAccount ? `Reg. ${st.bankReg}  Account ${st.bankAccount}` : "", st.iban ? `IBAN ${st.iban}` : "", st.bic ? `BIC ${st.bic}` : ""].filter(Boolean);
  doc.font("Helvetica-Bold").fontSize(9).text("Payment details", 50, y);
  doc.font("Helvetica").text(pay.join("\n") + `\nPlease state ${inv.number} with your payment. Payment within ${st.paymentDays} days.`, 50, y + 13);
  doc.end();
  return done;
}

if (process.env.SMTP_HOST) {
  const nodemailer = (await import("nodemailer")).default;
  const port = +(process.env.SMTP_PORT || 465);
  const tx = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  const from = process.env.MAIL_FROM || `${st.company} <${st.invoiceEmail}>`;
  const send = (o) => tx.sendMail({ from, replyTo: st.invoiceEmail, ...o });
  const admin = st.notifyEmail || st.invoiceEmail;

  for (const p of data.partners) {
    if (p.deleted) continue;
    if (p.status === "pending" && !p.adminNotifiedAt) {
      try {
        await send({ to: admin, subject: `New partner sign-up: ${p.name}`, text: `${p.name} (${p.category}) has signed up.\n\nContact: ${p.contactName || ""} ${p.email}\nWebsite: ${p.website || "-"}\nBooking system: ${SYSTEMS[p.integration?.type] || "-"}\n\nApprove or reject in the admin: ${data.origin}/admin.html` });
        p.adminNotifiedAt = nowISO(); touch(p); say(`Sign-up notice sent: ${p.name}`);
      } catch (e) { say(`Sign-up notice failed: ${e.message}`); }
    }
    if (p.status === "approved" && !p.welcomeSentAt && p.email) {
      const m = welcomeEmail(p, st, data.origin);
      try { await send({ to: p.email, bcc: admin, subject: m.subject, text: m.body }); p.welcomeSentAt = nowISO(); touch(p); say(`Welcome email sent to ${p.name}`); }
      catch (e) { say(`Welcome email to ${p.name} failed: ${e.message}`); }
    }
  }
  // Follow-up to the guest: did you use the voucher? (only when the partner has not registered it)
  for (const v of data.vouchers) {
    if (v.deleted || !v.guestEmail || !v.emailedAt || v.followUpSentAt || v.guestAnswer || (v.uses || []).length) continue;
    if (Date.now() - new Date(v.createdAt) < (+st.followUpHours || 24) * 36e5) continue;
    if (!v.confirmKey) v.confirmKey = randKey(24);
    const p = data.partners.find((x) => x.id === v.partnerId);
    try {
      await send({ to: v.guestEmail, subject: `Did you visit ${p?.name || "us"}? One quick question`, text: [
        `Hi ${v.guestName.split(" ")[0] || "there"},`, "",
        `You got a Hýsa guest voucher (${v.id}) for ${p?.name || "a local business"}. Did you use it?`, "",
        `Please tap here to answer, it takes 20 seconds:`, `${data.origin}/confirm.html#${v.confirmKey}`, "",
        "Thank you for helping us support local businesses.", "", st.company].join("\n") });
      v.followUpSentAt = nowISO(); touch(v); say(`Follow-up sent to ${v.guestEmail} (${v.id})`);
    } catch (e) { say(`Follow-up failed: ${e.message}`); }
  }
  for (const v of data.vouchers) {
    if (v.emailedAt || v.deleted || !v.guestEmail || (v.expiresAt || "") < nowISO()) continue;
    const p = data.partners.find((x) => x.id === v.partnerId);
    try {
      await send({ to: v.guestEmail, subject: `Your Hýsa guest voucher for ${p?.name || "your visit"}: ${v.id}`, text: [
        `Hi ${v.guestName.split(" ")[0] || "there"},`, "",
        `Here is your personal Hýsa guest voucher for ${p?.name || ""}.`, "",
        `Voucher code: ${v.id}`, v.offer ? `Offer: ${v.offer}` : null, `Valid until: ${(v.expiresAt || "").slice(0, 10)}`, p?.address ? `Address: ${p.address}` : null, "",
        "Show the code to the staff before you pay.", "", "Enjoy your stay,", st.company].filter((l) => l !== null).join("\n") });
      v.emailedAt = nowISO(); touch(v);
    } catch (e) { say(`Voucher email failed: ${e.message}`); }
  }
  for (const s of data.sales) {
    if (s.notifiedAt || !billable(s)) continue;
    const p = data.partners.find((x) => x.id === s.partnerId);
    if (!p?.email) continue;
    const m = saleEmail(s, p, st);
    try { await send({ to: m.to, bcc: admin, subject: m.subject, text: m.body }); s.notifiedAt = nowISO(); touch(s); say(`Sale email to ${p.name}: ${fmtMoney(s.amount, s.currency)}`); }
    catch (e) { say(`Sale email to ${p.name} failed: ${e.message}`); }
  }
  const newReceipts = data.sales.filter((s) => (s.review === "pending" || s.flagged) && !s.adminNotifiedAt && !s.deleted);
  if (newReceipts.length) {
    try {
      await send({ to: admin, subject: `Hýsa: ${newReceipts.length} guest purchase(s) to check`, text: newReceipts.map((s) => `${s.date} ${data.partners.find((p) => p.id === s.partnerId)?.name}: ${fmtMoney(s.amount, s.currency)} (${s.guestName})`).join("\n") + `\n\nCheck them in the admin: ${data.origin}/admin.html` });
      newReceipts.forEach((s) => { s.adminNotifiedAt = nowISO(); touch(s); });
    } catch (e) { say(`Receipt notice failed: ${e.message}`); }
  }
  for (const inv of data.invoices) {
    if (inv.deleted || inv.sentAt || !inv.sendRequested) continue;
    const p = data.partners.find((x) => x.id === inv.partnerId);
    const to = inv.sendTo || p?.invoiceEmail || p?.email;
    if (!to) continue;
    try {
      const m = invoiceEmail(inv, p, st);
      await send({ to, bcc: admin, subject: m.subject, text: m.body, attachments: [{ filename: `${inv.number}.pdf`, content: await invoicePDF(inv) }] });
      Object.assign(inv, { sentAt: nowISO(), sendRequested: false, sendTo: to, sendError: "" }); touch(inv); say(`Invoice ${inv.number} emailed to ${to}`);
    } catch (e) { inv.sendError = e.message; touch(inv); say(`Invoice ${inv.number} failed: ${e.message}`); }
  }
} else say("Email is not set up yet (SMTP secrets missing)");

/* ---------- save changes ---------- */
const docs = [];
for (const [k, arr] of [["partner", data.partners], ["sale", data.sales], ["invoice", data.invoices], ["voucher", data.vouchers]]) for (const d of arr) if (before.get(`${k}:${d.id}`) !== JSON.stringify(d)) docs.push({ kind: k, doc: d });
const prevLog = data.sync?.log || [];
docs.push({ kind: "meta", doc: { id: "sync", lastRun: nowISO(), log: [...log.reverse(), ...prevLog].slice(0, 100), updatedAt: nowISO() } });
for (let i = 0; i < docs.length; i += 200) {
  const r = await fetch(`${BASE}/api/job/upsert`, { method: "POST", headers: H, body: JSON.stringify({ docs: docs.slice(i, i + 200) }) });
  if (!r.ok) throw new Error(`Save failed: ${r.status}`);
}
console.log(`Done. ${added} new online sales, ${docs.length - 1} records updated.`);
