const express = require("express");
const path = require("path");
const storage = require("./storage");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ===== يوزر وباس =====
const USERNAME = "gold";
const PASSWORD = "2626";

// ===== أدوات =====
const daysBetween = (a, b) => Math.floor((b - a) / 86400000);

const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// ✅ دعم الأرقام العربية + الفواصل
function normalizeArabicDigits(s) {
  const str = String(s ?? "");
  const map = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4",
    "٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4",
    "۵":"5","۶":"6","۷":"7","۸":"8","۹":"9"
  };
  return str
    .replace(/[٠-٩۰-۹]/g, ch => map[ch] ?? ch)
    .replace(/[,،\s]/g, "");
}

function parseAmount(v) {
  const n = Number(normalizeArabicDigits(v));
  return Number.isFinite(n) ? n : NaN;
}

function normalizeMovement(m) {
  const obj = m && typeof m === "object" ? m : {};
  const amount = parseAmount(obj.amount);
  return {
    id: obj.id || newId(),
    amount: Number.isFinite(amount) ? amount : 0,
    date: obj.date || new Date().toISOString()
  };
}

function normalizeDebt(d) {
  const obj = d && typeof d === "object" ? d : {};
  const totalAmount = parseAmount(obj.totalAmount);
  const remaining = parseAmount(obj.remaining);

  const payments = Array.isArray(obj.payments) ? obj.payments.map(normalizeMovement) : [];
  const additions = Array.isArray(obj.additions) ? obj.additions.map(normalizeMovement) : [];
  const auditLog = Array.isArray(obj.auditLog) ? obj.auditLog : [];

  return {
    id: obj.id || Date.now(),
    name: obj.name || "",
    phone: obj.phone || "",
    address: obj.address || "",
    totalAmount: Number.isFinite(totalAmount) ? totalAmount : 0,
    remaining: Number.isFinite(remaining) ? remaining : 0,
    notes: obj.notes || "",
    createdAt: obj.createdAt || new Date().toISOString(),
    payments,
    additions,
    auditLog
  };
}

function clampDebtNumbers(d) {
  d.totalAmount = Number(d.totalAmount || 0);
  d.remaining = Number(d.remaining || 0);

  if (d.totalAmount < 0) d.totalAmount = 0;
  if (d.remaining < 0) d.remaining = 0;
  if (d.remaining > d.totalAmount) d.remaining = d.totalAmount;
  return d;
}

function pushAudit(d, action, payload = {}) {
  if (!Array.isArray(d.auditLog)) d.auditLog = [];
  d.auditLog.push({
    id: newId(),
    action,
    at: new Date().toISOString(),
    ...payload
  });
  if (d.auditLog.length > 200) d.auditLog = d.auditLog.slice(d.auditLog.length - 200);
}

// ✅ قراءة أحدث نسخة (Cloud-first)
async function readDebtsNormalized() {
  let arr = null;

  try {
    // نحاول نقرأ من السحابة (المصدر الرئيسي)
    arr = await storage.loadCloud();
    if (Array.isArray(arr)) {
      storage.saveLocal(arr); // نحدث المحلي حتى الأجهزة تبقى متطابقة
    }
  } catch (e) {
    console.error("loadCloud failed, fallback to local:", e?.message || e);
  }

  // إذا السحابة فشلت نرجع للمحلي
  if (!Array.isArray(arr)) {
    arr = storage.loadLocal();
  }

  if (!Array.isArray(arr)) arr = [];

  const normalized = arr.map(normalizeDebt).map(clampDebtNumbers);

  const before = JSON.stringify(arr);
  const after = JSON.stringify(normalized);
  if (before !== after) storage.saveLocal(normalized);

  return normalized;
}

// ✅ حفظ محلي + Auto Sync للسحابة
const saveDebts = async (debts, touchedId = null) => {
  storage.saveLocal(debts);
  try {
    await storage.autoSync(debts, touchedId, pushAudit);
  } catch (e) {
    console.error("AutoSync failed:", e?.message || e);
  }
};

// ===== حماية =====
function auth(req, res, next) {
  const h = req.headers.authorization;

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("WWW-Authenticate", 'Basic realm="Debts App"');

  if (!h || !h.startsWith("Basic ")) return res.sendStatus(401);

  try {
    const decoded = Buffer.from(h.split(" ")[1], "base64").toString();
    const [u, p] = decoded.split(":");
    if (u !== USERNAME || p !== PASSWORD) return res.sendStatus(403);
    next();
  } catch {
    return res.sendStatus(401);
  }
}

// ===== الواجهة =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ✅ مزامنة يدوية حقيقية (يشتغل زر المزامنة)
app.post("/sync", auth, async (req, res) => {
  try {
    const debts = await readDebtsNormalized();
    await storage.forceSync(debts);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ===== إضافة زبون / دين جديد =====
app.post("/debts", auth, async (req, res) => {
  const { name, phone, address, totalAmount, remaining, notes } = req.body;

  if (!name || totalAmount === undefined || totalAmount === null || totalAmount === "")
    return res.status(400).json({ error: "بيانات ناقصة" });

  const total = parseAmount(totalAmount);
  if (!Number.isFinite(total) || total <= 0)
    return res.status(400).json({ error: "المبلغ الكلي غير صحيح" });

  const rem =
    remaining === undefined || remaining === null || remaining === ""
      ? total
      : parseAmount(remaining);

  if (!Number.isFinite(rem) || rem < 0)
    return res.status(400).json({ error: "الباقي غير صحيح" });

  const debts = await readDebtsNormalized();

  const debt = clampDebtNumbers({
    id: Date.now(),
    name: String(name).trim(),
    phone: phone ? String(phone).trim() : "",
    address: address ? String(address).trim() : "",
    totalAmount: total,
    remaining: rem,
    notes: notes ? String(notes).trim() : "",
    createdAt: new Date().toISOString(),
    payments: [],
    additions: [],
    auditLog: []
  });

  pushAudit(debt, "CREATE_DEBT", { totalAmount: debt.totalAmount, remaining: debt.remaining });

  debts.push(debt);
  await saveDebts(debts, debt.id);
  res.json(debt);
});

// ===== إضافة دين لنفس المديون =====
app.post("/debts/:id/add", auth, async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: "مبلغ الإضافة غير صحيح" });

  const debts = await readDebtsNormalized();
  const d = debts.find(x => x.id == req.params.id);
  if (!d) return res.sendStatus(404);

  const mov = { id: newId(), amount, date: new Date().toISOString() };
  d.additions.push(mov);

  d.totalAmount = Number(d.totalAmount || 0) + amount;
  d.remaining = Number(d.remaining || 0) + amount;

  clampDebtNumbers(d);
  pushAudit(d, "ADD_DEBT", { itemId: mov.id, amount });

  await saveDebts(debts, d.id);
  res.json(d);
});

// ===== تسديد دين =====
app.post("/debts/:id/pay", auth, async (req, res) => {
  const amount = parseAmount(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: "مبلغ التسديد غير صحيح" });

  const debts = await readDebtsNormalized();
  const d = debts.find(x => x.id == req.params.id);
  if (!d) return res.sendStatus(404);

  const currentRemaining = Number(d.remaining || 0);
  if (currentRemaining <= 0)
    return res.status(400).json({ error: "هذا الدين مسدد بالكامل" });

  if (amount > currentRemaining)
    return res.status(400).json({ error: "مبلغ التسديد أكبر من الباقي" });

  const mov = { id: newId(), amount, date: new Date().toISOString() };
  d.payments.push(mov);

  d.remaining = currentRemaining - amount;

  clampDebtNumbers(d);
  pushAudit(d, "PAY", { itemId: mov.id, amount });

  await saveDebts(debts, d.id);
  res.json(d);
});

// ===== تعديل/حذف تسديدة =====
app.put("/debts/:id/payments/:pid", auth, async (req, res) => {
  const newAmount = parseAmount(req.body.amount);
  if (!Number.isFinite(newAmount) || newAmount <= 0)
    return res.status(400).json({ error: "مبلغ التعديل غير صحيح" });

  const debts = await readDebtsNormalized();
  const d = debts.find(x => x.id == req.params.id);
  if (!d) return res.sendStatus(404);

  const p = d.payments.find(x => x.id == req.params.pid);
  if (!p) return res.sendStatus(404);

  const oldAmount = Number(p.amount || 0);

  d.remaining = Number(d.remaining || 0) + oldAmount;

  if (newAmount > Number(d.remaining || 0))
    return res.status(400).json({ error: "المبلغ الجديد أكبر من الباقي بعد التعديل" });

  d.remaining = Number(d.remaining || 0) - newAmount;
  p.amount = newAmount;

  clampDebtNumbers(d);
  pushAudit(d, "EDIT_PAYMENT", { itemId: p.id, oldAmount, newAmount });

  await saveDebts(debts, d.id);
  res.json(d);
});

app.delete("/debts/:id/payments/:pid", auth, async (req, res) => {
  const debts = await readDebtsNormalized();
  const d = debts.find(x => x.id == req.params.id);
  if (!d) return res.sendStatus(404);

  const idx = d.payments.findIndex(x => x.id == req.params.pid);
  if (idx === -1) return res.sendStatus(404);

  const oldAmount = Number(d.payments[idx].amount || 0);
  d.payments.splice(idx, 1);
  d.remaining = Number(d.remaining || 0) + oldAmount;

  clampDebtNumbers(d);
  pushAudit(d, "DELETE_PAYMENT", { itemId: req.params.pid, oldAmount });

  await saveDebts(debts, d.id);
  res.json(d);
});

// ===== تعديل/حذف إضافة دين =====
app.put("/debts/:id/additions/:aid", auth, async (req, res) => {
  const newAmount = parseAmount(req.body.amount);
  if (!Number.isFinite(newAmount) || newAmount <= 0)
    return res.status(400).json({ error: "مبلغ التعديل غير صحيح" });

  const debts = await readDebtsNormalized();
  const d = debts.find(x => x.id == req.params.id);
  if (!d) return res.sendStatus(404);

  const a = d.additions.find(x => x.id == req.params.aid);
  if (!a) return res.sendStatus(404);

  const oldAmount = Number(a.amount || 0);
  const delta = newAmount - oldAmount;

  d.totalAmount = Number(d.totalAmount || 0) + delta;
  d.remaining = Number(d.remaining || 0) + delta;
  a.amount = newAmount;

  clampDebtNumbers(d);
  pushAudit(d, "EDIT_ADDITION", { itemId: a.id, oldAmount, newAmount });

  await saveDebts(debts, d.id);
  res.json(d);
});

app.delete("/debts/:id/additions/:aid", auth, async (req, res) => {
  const debts = await readDebtsNormalized();
  const d = debts.find(x => x.id == req.params.id);
  if (!d) return res.sendStatus(404);

  const idx = d.additions.findIndex(x => x.id == req.params.aid);
  if (idx === -1) return res.sendStatus(404);

  const oldAmount = Number(d.additions[idx].amount || 0);

  d.additions.splice(idx, 1);
  d.totalAmount = Number(d.totalAmount || 0) - oldAmount;
  d.remaining = Number(d.remaining || 0) - oldAmount;

  clampDebtNumbers(d);
  pushAudit(d, "DELETE_ADDITION", { itemId: req.params.aid, oldAmount });

  await saveDebts(debts, d.id);
  res.json(d);
});

// ===== تعديل معلومات الزبون =====
app.put("/debts/:id", auth, async (req, res) => {
  const { name, phone, address, notes } = req.body;

  if (!name || String(name).trim().length < 2)
    return res.status(400).json({ error: "اسم الزبون مطلوب" });

  const debts = await readDebtsNormalized();
  const d = debts.find(x => x.id == req.params.id);
  if (!d) return res.sendStatus(404);

  const old = { name: d.name, phone: d.phone, address: d.address, notes: d.notes };

  d.name = String(name).trim();
  d.phone = phone === undefined ? d.phone : String(phone).trim();
  d.address = address === undefined ? d.address : String(address).trim();
  d.notes = notes === undefined ? d.notes : String(notes).trim();

  pushAudit(d, "EDIT_CUSTOMER", {
    old,
    updated: { name: d.name, phone: d.phone, address: d.address, notes: d.notes }
  });

  await saveDebts(debts, d.id);
  res.json(d);
});

// ===== حذف زبون (تأكيد بالاسم) =====
app.delete("/debts/:id", auth, async (req, res) => {
  const confirmName = String(req.body?.confirmName || "").trim();

  const debts = await readDebtsNormalized();
  const idx = debts.findIndex(x => x.id == req.params.id);
  if (idx === -1) return res.sendStatus(404);

  const d = debts[idx];
  if (!confirmName || confirmName !== String(d.name || "").trim()) {
    return res.status(400).json({ error: "تأكيد الاسم غير صحيح" });
  }

  debts.splice(idx, 1);

  await saveDebts(debts, null);
  res.json({ ok: true });
});

// ===== كل الديون / دين واحد =====
app.get("/debts", auth, async (req, res) => {
  res.json(await readDebtsNormalized());
});

app.get("/debts/:id", auth, async (req, res) => {
  const debts = await readDebtsNormalized();
  const d = debts.find(x => x.id == req.params.id);
  if (!d) return res.sendStatus(404);
  res.json(d);
});

// ===== المتأخرين =====
app.get("/late-debts", auth, async (req, res) => {
  const now = new Date();
  const late = (await readDebtsNormalized()).filter(d =>
    daysBetween(new Date(d.createdAt), now) > 30 && Number(d.remaining) > 0
  );
  res.json(late);
});

// ===== مجموع الدين الكلي =====
app.get("/total-debt", auth, async (req, res) => {
  const debts = await readDebtsNormalized();
  const total = debts.reduce((sum, d) => sum + (Number(d.remaining) || 0), 0);
  res.json({ total });
});

// ===== Backup/Restore =====
app.get("/backup", auth, async (req, res) => {
  const debts = await readDebtsNormalized();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="debts-backup-${stamp}.json"`);
  res.send(JSON.stringify(debts, null, 2));
});

app.post("/restore", auth, async (req, res) => {
  let data = req.body;

  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.debts)) {
    data = data.debts;
  }

  if (!Array.isArray(data)) return res.status(400).json({ error: "صيغة النسخة الاحتياطية غير صحيحة" });

  const normalized = data.map(normalizeDebt).map(clampDebtNumbers);
  normalized.forEach(d => pushAudit(d, "RESTORE", { note: "Restored from backup" }));

  await saveDebts(normalized, null);
  res.json({ ok: true, count: normalized.length });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
