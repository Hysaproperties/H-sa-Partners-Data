// Shared logic: used by the admin page (browser), the Cloudflare worker and the hourly GitHub job.

export const uid = (p = "") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const randKey = (n = 24) => { const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map((x) => a[x % a.length]).join(""); };
export const nowISO = () => new Date().toISOString();
export const today = () => nowISO().slice(0, 10);

export const CATEGORIES = ["Car rental", "Restaurant", "Café & bakery", "Guided tour", "Boat trip", "Attraction", "Activity", "Shop & groceries", "Transport", "Wellness", "Other"];
export const SYSTEMS = { shopify: "Shopify", woocommerce: "WooCommerce", script: "Other website (tracking code)", none: "No online booking" };
export const AGR = { percent: "% of purchase", fixed_order: "Fixed per booking", fixed_person: "Fixed per person" };

export function defaultSettings() {
  return {
    id: "main", company: "Hýsa Sp/f", address: "Heygsvegur 33, Tórshavn, Faroe Islands", companyId: "",
    invoiceEmail: "hysa@hysa.fo", notifyEmail: "hysa@hysa.fo", invoicePrefix: "HYSA-AFF",
    bankName: "Betri Banki", bankReg: "9181", bankAccount: "5763233", iban: "FO6691810006131923", bic: "EIKBFOTF",
    vatRate: 25, paymentDays: 8, invoiceDay: 1, autoInvoice: true, defaultRate: 10, cookieDays: 30, voucherDays: 7, voucherUses: 0, followUpHours: 24, invoiceFrequency: "weekly", receiptReviewDays: 3, defaultCashback: 5,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

export function commission(partner, amount, persons) {
  const a = partner?.agreement || {};
  const r = +a.rate || 0;
  let c;
  if (a.type === "fixed_order") c = r;
  else if (a.type === "fixed_person") c = r * (+persons || 1);
  else c = ((+amount || 0) * r) / 100;
  return Math.round(c * 100) / 100;
}
export function fmtMoney(n, cur = "DKK") {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur || "DKK" }).format(+n || 0); }
  catch { return `${cur} ${(+n || 0).toFixed(2)}`; }
}
export function agrLabelVat(p) { return `${agrLabel(p)}${(p?.agreement?.type || "percent") === "percent" ? " excl. VAT" : ""}`; }
export function agrLabel(p) {
  const a = p?.agreement || {};
  if (a.type === "fixed_order") return `${fmtMoney(a.rate, p.currency)} per booking`;
  if (a.type === "fixed_person") return `${fmtMoney(a.rate, p.currency)} per person`;
  return `${+a.rate || 0}% of purchase`;
}
export function agreementActive(p, date) {
  if (!p || p.deleted || p.status !== "approved" || p.active === false) return false;
  const a = p.agreement || {};
  const d = (date || nowISO()).slice(0, 10);
  if (a.validFrom && d < a.validFrom) return false;
  if (a.validTo && d > a.validTo) return false;
  return true;
}
export const slugify = (s) => (s || "partner").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "partner";
export function withParams(url, params) {
  let u = (url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const [base, hash] = u.split("#");
  return base + (base.includes("?") ? "&" : "?") + q + (hash ? "#" + hash : "");
}
export const normRef = (r) => String(r || "").replace(/^#/, "").trim().toLowerCase();
export const billable = (s) => !s.deleted && s.review !== "pending" && s.review !== "rejected" && s.review !== "disputed";

/* ---- VAT: guests pay prices incl. VAT; Hýsa's commission is calculated excl. VAT ---- */
export const exVat = (amount, vat = 25) => Math.round(((+amount || 0) / (1 + (+vat || 0) / 100)) * 100) / 100;
export const saleBase = (s) => (s && s.amountExVat != null ? +s.amountExVat : +s?.amount || 0);
export const vatNote = (s) => (s?.vatIncluded ? "incl. VAT" : s?.amountExVat != null ? "excl. VAT" : "");

/* ---- the deal ----
   The partner only states its kickback: what it pays Hýsa per sale, in total, excl. VAT.
   Hýsa decides if part of it goes to the guest:
   - discount: the guest gets X% off at the partner (voucher in person, discount code online). The discount (excl. VAT) is deducted from the invoice.
   - cashback: the guest pays full price and Hýsa pays X% back after the receipt. Hýsa pays it from its own commission.
   The partner never pays more than the kickback. */
export const BENEFITS = { none: "Nothing", discount: "A discount at the partner (deducted from our commission)", cashback: "Cashback from Hýsa after the receipt" };
export const FREQ = { weekly: "Every week (Monday)", monthly: "Every month (day 1)" };
export function benefit(p) {
  const g = p?.guestBenefit;
  if (g && BENEFITS[g.mode]) return { mode: g.mode, kind: g.kind === "fixed" ? "fixed" : "percent", rate: Math.max(0, +g.rate || 0), code: g.mode === "discount" ? String(g.code || "").trim() : "" };
  // partners from before the deal model: a "10% off" text becomes a 10% discount
  const m = String(p?.discountText || "").match(/([0-9]+(?:[.,][0-9]+)?)\s*%/);
  if (m) return { mode: "discount", kind: "percent", rate: +m[1].replace(",", "."), code: String(p?.discountCode || "").trim(), legacy: true };
  return { mode: "none", kind: "percent", rate: 0, code: "", legacy: !!(p?.discountText || p?.discountCode) };
}
export const codeFor = (p) => benefit(p).code || String(p?.discountCode || "").trim();
// "5%" or "100 kr" – what the guest gets, shown to guests and partners
export const benefitAmount = (p) => { const b = benefit(p); return b.kind === "fixed" ? `${b.rate} ${p?.currency === "EUR" ? "EUR" : "kr"}` : `${b.rate}%`; };
export function benefitLabel(p) {
  const b = benefit(p);
  if (b.mode === "cashback") return `${benefitAmount(p)} cashback from Hýsa`;
  if (b.mode === "discount") return `${benefitAmount(p)} off at the partner${b.code ? ` (online code ${b.code})` : ""}`;
  return "Nothing";
}
export const guestOfferText = (p) => { const b = benefit(p); return !(b.rate > 0) ? "" : b.mode === "discount" ? `${benefitAmount(p)} off for Hýsa guests` : b.mode === "cashback" ? `${benefitAmount(p)} cashback from Hýsa` : ""; };
// What the guest gets on one purchase (amount incl. VAT that the guest paid / would pay)
export const benefitValue = (p, amount) => { const b = benefit(p); if (!(b.rate > 0)) return 0; return b.kind === "fixed" ? Math.min(b.rate, +amount || 0) : Math.round((+amount || 0) * b.rate) / 100; };
// What Hýsa keeps, shown as a worked example on a 1,000 kr purchase (price incl. VAT, before any discount)
export function keepsLabel(p, vat = 25) {
  const a = p?.agreement || {}, b = benefit(p), full = 1000, ex = exVat(full, vat);
  const kick = (a.type || "percent") === "percent" ? Math.round(ex * (+a.rate || 0)) / 100 : null;
  if (kick == null) return b.mode === "none" ? agrLabel(p) : `${agrLabel(p)} minus the ${b.mode} (${benefitAmount(p)})`;
  if (b.kind === "fixed" && b.mode !== "none") {
    const give = b.mode === "discount" ? exVat(b.rate, vat) : b.rate;
    const even = Math.ceil(((give * 100) / (+a.rate || 1)) * (1 + vat / 100));
    return `${agrLabel(p)} excl. VAT − ${give} kr per purchase (${b.rate} kr ${b.mode}${b.mode === "discount" ? " incl. VAT" : ""}). Hýsa earns on purchases above ${even.toLocaleString("en-GB")} kr incl. VAT`;
  }
  const val = benefitValue(p, full), give = b.mode === "discount" ? exVat(val, vat) : b.mode === "cashback" ? val : 0;
  const keep = Math.round((kick - give) * 100) / 100;
  if (b.mode === "none") return `${kick} kr per 1,000 kr the guest pays (incl. VAT)`;
  return `${keep} kr per 1,000 kr the guest pays (${kick} kr commission − ${give} kr ${b.mode === "discount" ? "discount excl. VAT" : "cashback"})`;
}
// The commission line for one sale: kickback on the full price excl. VAT, minus any Hýsa guest discount (excl. VAT)
export function saleCommission(p, { baseExVat, persons = 1, discountExVat = 0 }) {
  const kickback = commission(p, baseExVat, persons);
  return { kickback, guestDiscount: Math.round((+discountExVat || 0) * 100) / 100, commission: Math.max(0, Math.round((kickback - (+discountExVat || 0)) * 100) / 100) };
}
export const cashbackAmount = (p, amount) => (benefit(p).mode === "cashback" ? benefitValue(p, amount) : 0);
// Where a guest's cashback is in its life: review → waiting (partner has not paid) → ready → paid; failed = needs a manual payout
export function cashbackState(s) {
  const c = s?.cashback;
  if (!c || !(+c.amount > 0)) return "";
  if (c.paidAt) return "paid";
  if (s.deleted || s.review === "rejected") return "cancelled";
  if (c.error) return "failed";
  if (s.review === "pending" || s.review === "disputed") return "review";
  if (s.status === "paid") return "ready";
  return "waiting";
}
export const CB_LABEL = { review: "Receipt being checked", waiting: "Waiting for partner payment", ready: "Ready to pay out", paid: "Paid to guest", failed: "Pay manually", cancelled: "Cancelled" };

export function publicPartner(p) {
  return {
    id: p.id, slug: p.slug, name: p.name, category: p.category, description: p.description || "",
    discountCode: benefit(p).mode === "discount" && benefit(p).rate > 0 ? codeFor(p) : "", discountText: benefit(p).mode === "discount" ? guestOfferText(p) : "",
    benefit: benefit(p).mode, kind: benefit(p).kind, cashback: benefit(p).mode === "cashback" ? benefit(p).rate : 0, discount: benefit(p).mode === "discount" ? benefit(p).rate : 0, benefitAmount: benefit(p).rate > 0 ? benefitAmount(p) : "",
    go: p.website ? `/go/${p.slug}` : "", website: (p.website || "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
    phone: p.phone || "", email: p.publicEmail || p.email || "", address: p.address || "", hours: p.hours || "",
  };
}

export function nextInvoiceNumber(invoices, settings, date = new Date()) {
  const yr = date.getFullYear(), prefix = settings.invoicePrefix || "HYSA-AFF";
  const nums = invoices.filter((x) => (x.number || "").startsWith(`${prefix}-${yr}-`)).map((x) => +x.number.split("-").pop() || 0);
  return `${prefix}-${yr}-${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
}
// Creates an invoice for the given sales and marks them invoiced (mutates sales). Returns the invoice.
export function createInvoice({ invoices, settings, partner, sales, from, to, auto = false }) {
  const ts = nowISO();
  const sorted = [...sales].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const net = Math.round(sorted.reduce((a, s) => a + (+s.commission || 0), 0) * 100) / 100;
  const vatRate = +settings.vatRate || 0;
  const vat = Math.round(net * vatRate) / 100;
  const due = new Date(); due.setDate(due.getDate() + (+settings.paymentDays || 8));
  const sendTo = partner.invoiceEmail || partner.email || "";
  const inv = {
    id: uid("i_"), number: nextInvoiceNumber(invoices, settings), partnerId: partner.id, partnerName: partner.name,
    from: from || sorted[0]?.date, to: to || sorted[sorted.length - 1]?.date,
    net, vatRate, vat, total: Math.round((net + vat) * 100) / 100, currency: partner.currency || "DKK",
    status: "invoiced", dueDate: due.toISOString().slice(0, 10), auto, sendTo, sentAt: null, sendRequested: !!sendTo,
    createdAt: ts, updatedAt: ts,
  };
  invoices.push(inv);
  for (const s of sorted) { s.status = "invoiced"; s.invoiceId = inv.id; s.updatedAt = ts; }
  return inv;
}

const howLabel = (s) => ({ shopify: "Online (Shopify, via Hýsa link)", woocommerce: "Online (webshop, via Hýsa link)", script: "Online (via Hýsa link)", partner: "In person, reported by you", voucher: "In person, Hýsa guest voucher", guest: "In person, receipt from guest", admin: "Registered by Hýsa" }[s.source] || "Referral");

export function saleEmail(sale, partner, settings) {
  const co = settings?.company || "Hýsa Sp/f";
  const lines = [
    `Dear ${partner?.contactName || partner?.name || "partner"},`, "",
    `A guest referred by ${co} has made a purchase with you. Please check that it matches your records.`, "",
    `Date: ${(sale.date || "").slice(0, 10)}`,
    `How: ${howLabel(sale)}`,
    sale.orderRef ? `Order / receipt no.: ${sale.orderRef}` : null,
    sale.guestName ? `Guest: ${sale.guestName}` : null,
    `Purchase amount: ${fmtMoney(sale.amount, sale.currency)}${sale.vatIncluded ? " incl. VAT" : sale.amountExVat != null ? " excl. VAT" : ""}`, "",
    `Agreement: ${sale.rateLabel || agrLabel(partner)}${sale.amountExVat != null ? ` of ${fmtMoney(sale.amountExVat, sale.currency)} excl. VAT` : ""}`,
    sale.guestDiscount ? `Commission: ${fmtMoney(sale.kickback, sale.currency)} − Hýsa guest discount you gave ${fmtMoney(sale.guestDiscount, sale.currency)} (excl. VAT)` : null,
    `Commission to ${co}: ${fmtMoney(sale.commission, sale.currency)} (excl. VAT)`, "",
    "It will be included on your next invoice. Please reply to this email within 7 days if anything does not match.", "",
    "Kind regards,", co,
  ].filter((l) => l !== null);
  return { to: partner?.email || "", subject: `${co} referral: ${fmtMoney(sale.amount, sale.currency)} on ${(sale.date || "").slice(0, 10)}${sale.orderRef ? ` (${sale.orderRef})` : ""}`, body: lines.join("\n") };
}

export function invoiceEmail(inv, partner, settings) {
  const co = settings.company || "Hýsa Sp/f";
  const pay = [settings.bankName, settings.bankReg && settings.bankAccount ? `reg. ${settings.bankReg} account ${settings.bankAccount}` : "", settings.iban ? `IBAN ${settings.iban}` : "", settings.bic ? `BIC ${settings.bic}` : ""].filter(Boolean).join(", ");
  return {
    subject: `Invoice ${inv.number} from ${co} – ${fmtMoney(inv.total, inv.currency)}`,
    body: [
      `Dear ${partner?.contactName || partner?.name || "partner"},`, "",
      `Please find attached invoice ${inv.number} for referral commission for the period ${inv.from} to ${inv.to}.`, "",
      `Amount due: ${fmtMoney(inv.total, inv.currency)} incl. ${inv.vatRate}% VAT`, `Due date: ${inv.dueDate}`,
      pay ? `Payment to: ${pay}` : null, `Please state ${inv.number} with your payment.`, "",
      "The invoice lists every referred order with date, order number and amount.", "",
      "Kind regards,", co, settings.address || "", settings.invoiceEmail || "",
    ].filter((l) => l !== null).join("\n"),
  };
}

export function welcomeEmail(partner, settings, baseUrl) {
  const co = settings.company || "Hýsa Sp/f";
  const portal = `${baseUrl}/partner.html#${partner.portalKey}`;
  return {
    subject: `Welcome to the ${co} partner programme`,
    body: [
      `Dear ${partner.contactName || partner.name},`, "",
      `${partner.name} is now approved as a ${co} partner and is shown in our guest guide.`, "",
      `Agreed commission: ${agrLabel(partner)} (excl. VAT), invoiced ${(partner.invoiceFrequency || settings.invoiceFrequency) === "monthly" ? "monthly" : "weekly"} with ${settings.paymentDays || 8} days payment terms.`, "",
      "Your partner page (keep this link private):", portal, "",
      ...(benefit(partner).mode === "discount" ? [`Hýsa guests get ${benefitAmount(partner)} off with you. In person they show a Hýsa voucher: check it on your partner page before they pay, give ${benefitAmount(partner)} off and register the amount.${codeFor(partner) ? ` Online: please create the discount code ${codeFor(partner)} (${benefitAmount(partner)} off) in your webshop.` : ""} The discount is deducted from your invoice, so you never pay more than the agreed commission in total.`, ""]
        : benefit(partner).mode === "cashback" ? [`Hýsa guests get ${benefitAmount(partner)} cashback from Hýsa. They pay your normal price; you do not need to do anything at the till.`, ""] : []),
      "On your partner page you can:",
      "- see every guest we have sent you and the commission",
      "- report purchases our guests make in person",
      "- connect your webshop or get the tracking code for your website", "",
      "Kind regards,", co,
    ].join("\n"),
  };
}

export function voucherEmail(v, p, st) {
  return { subject: `Your Hýsa guest voucher for ${p?.name || "your visit"}: ${v.id}`, body: [
    `Hi ${(v.guestName || "").split(" ")[0] || "there"},`, "",
    `Here is your personal Hýsa guest voucher for ${p?.name || ""}.`, "",
    `Voucher code: ${v.id}`, v.offer ? `Offer: ${v.offer}` : null, `Valid until: ${(v.expiresAt || "").slice(0, 10)}`, p?.address ? `Address: ${p.address}` : null, "",
    "Show the code to the staff before you pay.", "", "Enjoy your stay,", st.company].filter((l) => l !== null).join("\n") };
}
export function cashbackAckEmail(s, p, st) {
  const amt = fmtMoney(s.cashback.amount, s.cashback.currency);
  return { subject: `We got your receipt from ${p?.name || "your visit"}`, body: [`Hi ${(s.guestName || "").split(" ")[0] || "there"},`, "",
    `Thank you for your receipt from ${p?.name || "a local business"} (${fmtMoney(s.amount, s.currency)}).`, "",
    `You will get ${amt} back on the card you paid your Hýsa stay with. It usually takes 1–3 weeks.`, "", "Enjoy your stay,", st.company].join("\n") };
}
export function signupNoticeEmail(p, origin) {
  return { subject: `New partner sign-up: ${p.name}`, body: `${p.name} (${p.category}) has signed up.\n\nOffers Hýsa: ${agrLabel(p)} excl. VAT${p.offer?.notes ? ` – ${p.offer.notes}` : ""}\nContact: ${p.contactName || ""} ${p.email}\nWebsite: ${p.website || "-"}\nBooking system: ${SYSTEMS[p.integration?.type] || "-"}\n\nApprove or reject in the admin: ${origin}/admin.html` };
}

/* ---- partner health & change log ---- */
export const CHANGE_FIELDS = { name: "Business name", category: "Category", website: "Website", phone: "Phone", publicEmail: "Email for guests", address: "Address", hours: "Opening hours", description: "Description", discountText: "Old guest offer text", discountCode: "Old discount code", contactName: "Contact person", email: "Contact email", invoiceEmail: "Invoice email", companyId: "Company no." };
export function diffChanges(before, after, by) {
  const at = nowISO(), out = [];
  for (const [k, label] of Object.entries(CHANGE_FIELDS)) {
    const a = String(before?.[k] ?? "").trim(), b = String(after?.[k] ?? "").trim();
    if (a !== b) out.push({ at, by, field: k, label, from: a, to: b });
  }
  return out;
}
export function logChanges(p, changes) {
  if (changes && changes.length) p.changes = [...changes, ...(p.changes || [])].slice(0, 200);
  return p;
}
const DAY = 864e5;
export function partnerHealth(p, { sales = [], invoices = [] } = {}) {
  const now = Date.now(), since = now - 90 * DAY, issues = [], notes = [];
  const add = (lvl, text, who) => issues.push({ lvl, text, who });
  const a = p.agreement || {}, i = p.integration || {}, d = today();
  if (p.status === "rejected") add("red", "Rejected", "hysa");
  else if (p.active === false) add("red", "Deactivated", "hysa");
  else if (p.status === "approved" && a.validTo && d > a.validTo) add("red", `Agreement ended ${a.validTo}`, "hysa");
  else if (p.status === "approved" && a.validFrom && d < a.validFrom) add("red", `Agreement starts ${a.validFrom}`, "hysa");
  if (p.status === "pending") add("yellow", "Awaiting approval from Hýsa", "hysa");
  if (p.status === "approved" && p.showOnGuide === false) add("yellow", "Hidden from the guest guide", "hysa");
  const shop = i.type === "woocommerce" || i.type === "shopify";
  if (shop) {
    if (!(i.key || i.token)) add("yellow", `${SYSTEMS[i.type]} chosen, but the webshop is not connected`, "partner");
    else if (i.lastError) add("yellow", `Webshop connection error: ${i.lastError}`, "partner");
    else if (p.status === "approved" && i.lastSync && now - Date.parse(i.lastSync) > 3 * DAY) add("yellow", "Webshop orders not checked for 3+ days", "hysa");
    if (!p.scriptSeenAt) notes.push("Recommended tracking line not seen on the website yet");
  }
  if (i.type === "script" && !p.scriptSeenAt && !p.lastConversionAt) add("yellow", "Tracking code not found on the website", "partner");
  const miss = [["website", "website"], ["phone", "phone"], ["address", "address"], ["hours", "opening hours"], ["description", "description"]].filter(([k]) => !String(p[k] || "").trim()).map((x) => x[1]);
  if (miss.length) add("yellow", `Listing is missing: ${miss.join(", ")}`, "partner");
  const bn = benefit(p);
  if (bn.legacy && p.status === "approved") add("yellow", `Choose what Hýsa guests get (old offer text: “${p.discountText || p.discountCode}”)`, "hysa");
  if (bn.mode !== "none" && !(bn.rate > 0)) add("yellow", `${bn.mode === "discount" ? "Discount" : "Cashback"} chosen, but the amount is 0`, "hysa");
  if (bn.mode !== "none" && bn.kind !== "fixed" && (a.type || "percent") === "percent" && bn.rate >= (+a.rate || 0) / 1.25) add("yellow", `The guest ${bn.mode} is as high as the commission – Hýsa earns nothing`, "hysa");
  if (!p.email) add("yellow", "No contact email", "partner");
  const flagged = sales.filter((s) => s.partnerId === p.id && !s.deleted && s.flagged === "not_registered" && Date.parse(s.createdAt || s.date) > since).length;
  if (flagged) add("yellow", `${flagged} voucher purchase${flagged > 1 ? "s" : ""} confirmed by guests but not registered (90 days)`, "partner");
  const disputed = sales.filter((s) => s.partnerId === p.id && !s.deleted && s.review === "disputed").length;
  if (disputed) add("yellow", `${disputed} guest receipt${disputed > 1 ? "s" : ""} disputed by the partner – decide in Sales`, "hysa");
  const cbFail = sales.filter((s) => s.partnerId === p.id && cashbackState(s) === "failed").length;
  if (cbFail) add("yellow", `${cbFail} cashback${cbFail > 1 ? "s" : ""} to pay manually`, "hysa");
  const overdue = invoices.filter((v) => v.partnerId === p.id && !v.deleted && v.status !== "paid" && v.dueDate && v.dueDate < d);
  if (overdue.length) add("yellow", `${overdue.length} invoice${overdue.length > 1 ? "s" : ""} overdue`, "partner");
  const mine = sales.filter((s) => s.partnerId === p.id && !s.deleted && s.review !== "rejected").map((s) => s.date || "").sort();
  if (p.status === "approved") notes.push(mine.length ? `Last Hýsa purchase: ${mine[mine.length - 1]}` : "No Hýsa purchases yet");
  const changes = (p.changes || []).filter((c) => Date.parse(c.at) > since);
  const partnerChanges = changes.filter((c) => c.by === "partner");
  const level = issues.some((x) => x.lvl === "red") ? "red" : issues.length ? "yellow" : partnerChanges.length ? "blue" : "green";
  return { level, issues, notes, changes, partnerChanges };
}
export const HEALTH = { green: "All good", yellow: "Needs action", red: "Not active", blue: "Changed recently" };
