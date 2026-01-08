// storage.js
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

// ===== ملف الخزن المحلي =====
const FILE = path.join(__dirname, "debts.json");
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "[]");

// ===== MongoDB URI =====
// • محليًا: يستخدم الرابط المكتوب
// • أونلاين (Render): يستخدم MONGODB_URI من Environment Variables
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://tt629com_db_user:eTwICin6eTp4sHRN@cluster0.fz1wdvk.mongodb.net/?appName=Cluster0";

// حماية
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

async function getCollection() {
  const c = await getClient();
  return c.db(DB_NAME).collection(COLLECTION);
}

// ===== رفع للسحابة =====
async function syncToCloud(debts) {
  const col = await getCollection();

  await col.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        debts,
        updatedAt: new Date().toISOString()
      }
    },
    { upsert: true }
  );
}

// ===== سحب من السحابة (الأهم) =====
async function loadCloud() {
  const col = await getCollection();
  const doc = await col.findOne({ _id: STATE_ID });

  if (!doc || !Array.isArray(doc.debts)) {
    return null;
  }

  return doc.debts;
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
  loadCloud,     // 🔥 هاي الجديدة
  autoSync,
  forceSync
};
