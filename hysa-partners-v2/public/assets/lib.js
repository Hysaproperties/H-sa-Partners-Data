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
    vatRate: 25, paymentDays: 8, invoiceDay: 1, autoInvoice: true, defaultRate: 10, cookieDays: 30,
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
export const billable = (s) => !s.deleted && s.review !== "pending" && s.review !== "rejected";

export function publicPartner(p) {
  return {
    id: p.id, slug: p.slug, name: p.name, category: p.category, description: p.description || "",
    discountCode: p.discountCode || "", discountText: p.discountText || "",
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

const howLabel = (s) => ({ shopify: "Online (Shopify, via Hýsa link)", woocommerce: "Online (webshop, via Hýsa link)", script: "Online (via Hýsa link)", partner: "In person, reported by you", guest: "In person, receipt from guest", admin: "Registered by Hýsa" }[s.source] || "Referral");

export function saleEmail(sale, partner, settings) {
  const co = settings?.company || "Hýsa Sp/f";
  const lines = [
    `Dear ${partner?.contactName || partner?.name || "partner"},`, "",
    `A guest referred by ${co} has made a purchase with you. Please check that it matches your records.`, "",
    `Date: ${(sale.date || "").slice(0, 10)}`,
    `How: ${howLabel(sale)}`,
    sale.orderRef ? `Order / receipt no.: ${sale.orderRef}` : null,
    sale.guestName ? `Guest: ${sale.guestName}` : null,
    `Purchase amount: ${fmtMoney(sale.amount, sale.currency)}`, "",
    `Agreement: ${sale.rateLabel || agrLabel(partner)}`,
    `Commission to ${co}: ${fmtMoney(sale.commission, sale.currency)} (excl. VAT)`, "",
    "It will be included on your next monthly invoice. Please reply to this email within 7 days if anything does not match.", "",
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
      `Agreed commission: ${agrLabel(partner)} (excl. VAT), invoiced monthly with ${settings.paymentDays || 8} days payment terms.`, "",
      "Your partner page (keep this link private):", portal, "",
      "On your partner page you can:",
      "- see every guest we have sent you and the commission",
      "- report purchases our guests make in person",
      "- connect your webshop or get the tracking code for your website", "",
      "Kind regards,", co,
    ].join("\n"),
  };
}
