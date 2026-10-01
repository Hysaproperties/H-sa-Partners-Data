// Hourly jobs, run by GitHub Actions (.github/workflows/jobs.yml):
// 1. fetch new orders from connected Shopify / WooCommerce shops that came through a Hýsa link or code
// 2. guest receipts the partner did not dispute within N days are approved
// 3. weekly (Monday, previous Mon–Sun) or monthly (previous month) invoices
// 4. cashback to guests through Frisbii once the partner has paid
// 3. emails from hysa@hysa.fo: new sign-ups (to Hýsa), welcome (to approved partners), sale notifications, PDF invoices
import { commission, agrLabel, uid, randKey, nowISO, normRef, saleEmail, invoiceEmail, welcomeEmail, fmtMoney, createInvoice, billable, defaultSettings, SYSTEMS, cashbackState, codeFor, benefit, saleCommission, voucherEmail, cashbackAckEmail, signupNoticeEmail } from "../public/assets/lib.js";

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
      const code = (o.discount_codes || []).find((d) => codeEq(d.code, codeFor(p)));
      const link = viaHysa(o.landing_site) || (o.note_attributes || []).some((n) => /hysa/i.test(`${n.name}${n.value}`));
      if (!code && !link && !refs.has(normRef(o.name || o.id))) continue;
      const refunded = (o.refunds || []).reduce((a, rf) => a + (rf.transactions || []).filter((t) => t.kind === "refund").reduce((b, t) => b + (+t.amount || 0), 0), 0);
      const c = o.customer || {};
      const sub = +o.current_subtotal_price || +o.subtotal_price || 0, tax = o.taxes_included ? +o.current_total_tax || +o.total_tax || 0 : 0;
      const disc = code ? (o.taxes_included ? (+code.amount || 0) / (1 + (+st.vatRate || 25) / 100) : +code.amount || 0) : 0;
      out.push({ extId: `shopify:${o.id}`, orderRef: o.name || String(o.id), date: o.created_at, amount: Math.max(0, sub - tax - refunded), currency: o.currency,
        guestName: [c.first_name, c.last_name].filter(Boolean).join(" ") || o.billing_address?.name || "", guestEmail: o.email || c.email || "", guestPhone: o.phone || c.phone || "",
        clickId: clickIn(o.landing_site) || ((o.note_attributes || []).find((n) => n.name === "hysa_click") || {}).value || "", matchedBy: link ? "Hýsa link" : code ? `code ${code.code}` : "Hýsa link (returning guest)", discountExVat: disc });
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
      const code = (o.coupon_lines || []).find((c) => codeEq(c.code, codeFor(p)));
      const m = Object.fromEntries((o.meta_data || []).map((x) => [x.key, String(x.value ?? "")]));
      const entry = m._wc_order_attribution_session_entry || "";
      const link = viaHysa(entry) || /hysa/i.test(m._wc_order_attribution_utm_source || "");
      if (!code && !link && !refs.has(normRef(o.number || o.id))) continue;
      const b = o.billing || {};
      out.push({ extId: `woo:${o.id}`, orderRef: String(o.number || o.id), date: o.date_created_gmt ? o.date_created_gmt + "Z" : o.date_created,
        amount: Math.max(0, (+o.total || 0) - (+o.total_tax || 0) - (+o.shipping_total || 0) - (o.refunds || []).reduce((a, x) => a + Math.abs(+x.total || 0), 0)), currency: o.currency,
        guestName: [b.first_name, b.last_name].filter(Boolean).join(" "), guestEmail: b.email || "", guestPhone: b.phone || "", clickId: clickIn(entry), matchedBy: link ? "Hýsa link" : code ? `code ${code.code}` : "Hýsa link (returning guest)", discountExVat: code ? +code.discount || 0 : 0 });
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
        const dc = saleCommission(p, { baseExVat: o.amount + (benefit(p).mode === "discount" ? o.discountExVat : 0), persons: dup.persons || 1, discountExVat: benefit(p).mode === "discount" ? o.discountExVat : 0 });
        if (dup.status === "open" || !dup.status) Object.assign(dup, { amount: o.amount, amountExVat: o.amount + (benefit(p).mode === "discount" ? o.discountExVat : 0), vatIncluded: false, kickback: dc.kickback, guestDiscount: dc.guestDiscount, commission: dc.commission, guestName: dup.guestName || o.guestName, guestEmail: dup.guestEmail || o.guestEmail, guestPhone: dup.guestPhone || o.guestPhone });
        Object.assign(dup, { extId: o.extId, source: t }); touch(dup);
        continue;
      }
      n++;
      const ts = nowISO(), dsc = benefit(p).mode === "discount" ? o.discountExVat || 0 : 0;
      const sc = saleCommission(p, { baseExVat: o.amount + dsc, persons: 1, discountExVat: dsc });
      data.sales.push({ id: uid("s_"), partnerId: p.id, ...o, date: (o.date || ts).slice(0, 10), currency: o.currency || p.currency || "DKK", persons: 1, method: "online", source: t,
        amountExVat: Math.round((o.amount + dsc) * 100) / 100, vatIncluded: false, kickback: sc.kickback, guestDiscount: sc.guestDiscount, commission: sc.commission, rateLabel: agrLabel(p), status: "open", review: "approved", notifiedAt: null, createdAt: ts, updatedAt: ts });
    }
    Object.assign(p.integration, { lastSync: nowISO(), lastError: "" }); touch(p);
    added += n; if (n) say(`${p.name}: ${n} new order(s) via Hýsa`);
  } catch (e) {
    if (p.integration.lastError !== e.message) { p.integration.lastError = e.message; touch(p); }
    say(`${p.name}: ${e.message}`);
  }
}

/* ---------- 2. guest receipts: approved when the partner has not disputed them in time ---------- */
const reviewMs = (+st.receiptReviewDays || 3) * DAY;
for (const s of data.sales) {
  if (s.deleted || s.source !== "guest" || s.review !== "pending") continue;
  if (Date.now() - new Date(s.createdAt) < reviewMs) continue;
  Object.assign(s, { review: "approved", autoApprovedAt: nowISO() }); touch(s);
  say(`Guest receipt approved automatically (${s.guestName || "guest"}, ${fmtMoney(s.amount, s.currency)})`);
}

/* ---------- 3. invoices: weekly or monthly per partner ---------- */
const now = new Date();
const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const thisMonday = new Date(dayStart - ((now.getUTCDay() + 6) % 7) * DAY);
const weekEnd = new Date(thisMonday - DAY).toISOString().slice(0, 10), weekStart = new Date(thisMonday - 7 * DAY).toISOString().slice(0, 10);
const prevEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
const month = prevEnd.toISOString().slice(0, 7), monthEnd = prevEnd.toISOString().slice(0, 10);
if (st.autoInvoice !== false) {
  for (const p of data.partners) {
    if (p.deleted || p.status !== "approved" || p.autoInvoice === false) continue;
    const weekly = (p.invoiceFrequency || st.invoiceFrequency || "weekly") === "weekly";
    if (!weekly && now.getUTCDate() < (+st.invoiceDay || 1)) continue;
    const key = weekly ? `W${weekStart}` : month, end = weekly ? weekEnd : monthEnd, start = weekly ? weekStart : `${month}-01`;
    if (p.lastAutoInvoice === key) continue;
    const open = data.sales.filter((s) => billable(s) && s.partnerId === p.id && (!s.status || s.status === "open") && (s.date || "") <= end);
    if (open.length) {
      const first = open.map((s) => s.date).sort()[0];
      const inv = createInvoice({ invoices: data.invoices, settings: st, partner: p, sales: open, from: first < start ? first : start, to: end, auto: true });
      say(`Invoice ${inv.number} for ${p.name}: ${fmtMoney(inv.total, inv.currency)}`);
    }
    p.lastAutoInvoice = key; touch(p);
  }
}

/* ---------- 4. cashback to guests through Frisbii (only after the partner has paid) ---------- */
const FKEY = process.env.FRISBII_KEY, FAPI = (process.env.FRISBII_API || "https://api.frisbii.com/v1").replace(/\/$/, "");
async function frisbii(path, opt = {}) {
  const r = await fetch(`${FAPI}${path}`, { ...opt, headers: { Authorization: "Basic " + Buffer.from(`${FKEY}:`).toString("base64"), "Content-Type": "application/json", Accept: "application/json", ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new Error("Frisbii refused the API key (check FRISBII_KEY)");
  if (!r.ok) throw new Error(`Frisbii: ${j.error || j.message || r.status}`);
  return j;
}
async function payCashback(s, p) {
  const email = String(s.guestEmail || "").trim();
  if (!email) throw new Error("No guest email on the receipt");
  const minor = Math.round(+s.cashback.amount * 100), cur = s.cashback.currency || s.currency || "DKK";
  const customers = [];
  for (const e of [...new Set([email, email.toLowerCase()])]) {
    const j = await frisbii(`/list/customer?email=${encodeURIComponent(e)}&size=20&from=2015-01-01`);
    for (const c of j.content || []) if (!customers.some((x) => x.handle === c.handle)) customers.push(c);
  }
  if (!customers.length) throw new Error(`No Frisbii customer with the email ${email}`);
  const cands = [];
  for (const c of customers) {
    const j = await frisbii(`/list/invoice?customer=${encodeURIComponent(c.handle)}&state=settled&range=settled&from=2015-01-01&size=100`);
    for (const inv of j.content || []) if ((inv.currency || "").toUpperCase() === cur.toUpperCase() && (+inv.settled_amount || 0) - (+inv.refunded_amount || 0) >= minor) cands.push(inv);
  }
  if (!cands.length) throw new Error(`No paid ${cur} Frisbii payment with enough left to refund for ${email}`);
  cands.sort((a, b) => String(b.settled || "").localeCompare(String(a.settled || "")));
  const inv = cands[0];
  const rf = await frisbii("/refund", { method: "POST", body: JSON.stringify({ invoice: inv.handle, amount: minor, key: `hysa-cashback-${s.id}`, text: `Hýsa guest cashback – ${p?.name || "partner"}` }) });
  if (!["refunded", "processing"].includes(rf.state)) throw new Error(`Frisbii refund state: ${rf.state || "unknown"}`);
  return { refundId: rf.id || "", frisbiiInvoice: inv.handle, frisbiiCustomer: inv.customer || "" };
}
let cbWaitingKey = 0;
for (const s of data.sales) {
  if (cashbackState(s) !== "ready") continue;
  if (!FKEY) { cbWaitingKey++; continue; }
  const p = data.partners.find((x) => x.id === s.partnerId);
  try {
    const r = await payCashback(s, p);
    Object.assign(s.cashback, r, { paidAt: nowISO(), method: "frisbii", error: "" }); touch(s);
    say(`Cashback ${fmtMoney(s.cashback.amount, s.cashback.currency)} paid to ${s.guestEmail} via Frisbii`);
  } catch (e) { Object.assign(s.cashback, { error: e.message, failedAt: nowISO() }); s.adminNotifiedAt = null; touch(s); say(`Cashback for ${s.guestEmail || s.id} failed: ${e.message}`); }
}
if (cbWaitingKey) say(`${cbWaitingKey} cashback(s) ready, but FRISBII_KEY is not set up`);

/* ---------- 5. emails ---------- */
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
  const cols = [[50, "Date", 70], [120, "Order / receipt", 110], [230, "How", 90], [320, "Purchase excl. VAT", 110, "right"], [435, "Commission", 110, "right"]];
  doc.rect(50, y - 4, 495, 18).fill("#E9EDE8"); doc.fillColor("#000").font("Helvetica-Bold").fontSize(9);
  cols.forEach(([x, t, w, a]) => doc.text(t, x + 4, y, { width: w - 8, align: a || "left" }));
  y += 20; doc.font("Helvetica").fontSize(9);
  for (const s of lines) {
    if (y > 740) { doc.addPage(); y = 50; }
    const row = [s.date, s.orderRef || "-", s.method === "in-store" ? "In person" : "Online", fmtMoney(s.amountExVat != null ? s.amountExVat : s.amount, s.currency), fmtMoney(s.commission, s.currency)];
    cols.forEach(([x, , w, a], i) => doc.text(String(row[i]), x + 4, y, { width: w - 8, align: a || "left" }));
    y += 16; doc.moveTo(50, y - 3).lineTo(545, y - 3).strokeColor("#D5DBD3").lineWidth(0.5).stroke();
  }
  const gd = lines.reduce((t, x) => t + (+x.guestDiscount || 0), 0);
  if (gd > 0) { doc.fillColor(grey).fontSize(8).text(`Commission is shown after deducting the Hýsa guest discounts you gave: ${fmtMoney(gd, inv.currency)} excl. VAT in total.`, 50, y + 2, { width: 495 }); doc.fillColor("#000"); y += 16; }
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
        const n = signupNoticeEmail(p, data.origin);
        await send({ to: admin, subject: n.subject, text: n.body });
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
      const m = voucherEmail(v, p, st);
      await send({ to: v.guestEmail, subject: m.subject, text: m.body });
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
  for (const s of data.sales) {
    if (!s.cashback || s.deleted || !s.guestEmail) continue;
    const p = data.partners.find((x) => x.id === s.partnerId);
    const first = (s.guestName || "").split(" ")[0] || "there", amt = fmtMoney(s.cashback.amount, s.cashback.currency);
    if (!s.cashback.ackAt && !["cancelled"].includes(cashbackState(s)) && s.review !== "disputed") {
      try {
        const m = cashbackAckEmail(s, p, st);
        await send({ to: s.guestEmail, subject: m.subject, text: m.body });
        s.cashback.ackAt = nowISO(); touch(s);
      } catch (e) { say(`Receipt email failed: ${e.message}`); }
    }
    if (s.cashback.paidAt && !s.cashback.paidEmailAt) {
      try {
        await send({ to: s.guestEmail, subject: `${amt} back from Hýsa`, text: [`Hi ${first},`, "", `We have sent ${amt} back to the card you paid your Hýsa stay with, as cashback for your purchase at ${p?.name || "a local business"}.`, "", "It can take a few days before you see it on your account.", "", "Thank you for supporting local businesses,", st.company].join("\n") });
        s.cashback.paidEmailAt = nowISO(); touch(s);
      } catch (e) { say(`Cashback email failed: ${e.message}`); }
    }
  }
  const newReceipts = data.sales.filter((s) => (s.review === "pending" || s.review === "disputed" || s.flagged || cashbackState(s) === "failed") && !s.adminNotifiedAt && !s.deleted);
  if (newReceipts.length) {
    try {
      await send({ to: admin, subject: `Hýsa: ${newReceipts.length} guest purchase(s) to check`, text: newReceipts.map((s) => `${s.date} ${data.partners.find((p) => p.id === s.partnerId)?.name}: ${fmtMoney(s.amount, s.currency)} (${s.guestName})${s.review === "disputed" ? ` – DISPUTED: ${s.disputeReason}` : cashbackState(s) === "failed" ? ` – cashback to pay manually: ${s.cashback.error}` : ""}`).join("\n") + `\n\nCheck them in the admin: ${data.origin}/admin.html` });
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
docs.push({ kind: "meta", doc: { id: "sync", lastRun: nowISO(), frisbii: !!FKEY, log: [...log.reverse(), ...prevLog].slice(0, 100), updatedAt: nowISO() } });
for (let i = 0; i < docs.length; i += 200) {
  const r = await fetch(`${BASE}/api/job/upsert`, { method: "POST", headers: H, body: JSON.stringify({ docs: docs.slice(i, i + 200) }) });
  if (!r.ok) throw new Error(`Save failed: ${r.status}`);
}
console.log(`Done. ${added} new online sales, ${docs.length - 1} records updated.`);
