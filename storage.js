// storage.js
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

// ===== ملف الخزن المحلي =====
const FILE = path.join(__dirname, "debts.json");
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "[]");

// ===== MongoDB URI =====
// • محليًا: يستخدم رابطك الحالي
// • أونلاين (Render): يستخدم متغير البيئة MONGODB_URI
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://tt629com_db_user:eTwICin6eTp4sHRN@cluster0.fz1wdvk.mongodb.net/?appName=Cluster0";

// حماية إضافية
if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is not defined");
}

// ===== اسم الداتابيس والكلّكشن =====
const DB_NAME = "debts_app";
const COLLECTION = "app_state";

// نخزن كل الديون بوثيقة وحدة
const STATE_ID = "debts_state_v1";

let client = null;

// ===== محلي =====
function loadLocal() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveLocal(debts) {
  fs.writeFileSync(FILE, JSON.stringify(debts, null, 2));
}

// ===== Mongo Client =====
async function getClient() {
  if (client) return client;

  client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 7000
  });

  await client.connect();
  return client;
}

// ===== Sync للسحابة =====
async function syncToCloud(debts) {
  const c = await getClient();
  const col = c.db(DB_NAME).collection(COLLECTION);

  await col.updateOne(
    { _id: STATE_ID },
    { $set: { debts, updatedAt: new Date() } },
    { upsert: true }
  );
}

// ===== Auto Sync (غير قاتل للتطبيق) =====
async function autoSync(debts, debtId, pushAudit) {
  try {
    await syncToCloud(debts);
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e);

    if (debtId != null && typeof pushAudit === "function") {
      const d = debts.find(x => String(x.id) === String(debtId));
      if (d) {
        pushAudit(d, "SYNC_ERROR", { message: msg });
        saveLocal(debts);
      }
    }
    return { ok: false, error: msg };
  }
}

// ===== مزامنة يدوية =====
async function forceSync(debts) {
  await syncToCloud(debts);
  return { ok: true };
}

module.exports = {
  loadLocal,
  saveLocal,
  autoSync,
  forceSync
};
