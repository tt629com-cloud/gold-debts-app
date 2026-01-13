// storage.js
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

/* =========================
   Local storage (CACHE ONLY)
   ========================= */
const FILE = path.join(__dirname, "debts.json");
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "[]");

/* =========================
   MongoDB (SOURCE OF TRUTH)
   ========================= */
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://tt629com_db_user:eTwICin6eTp4sHRN@cluster0.fz1wdvk.mongodb.net/?appName=Cluster0";

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is not defined");
}

const DB_NAME = "debts_app";
const COLLECTION = "app_state";
const STATE_ID = "debts_state_v1";

let client = null;

/* =========================
   Mongo helpers
   ========================= */
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

/* =========================
   Local (CACHE)
   ========================= */
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

/* =========================
   Cloud (MASTER)
   ========================= */
async function loadCloud() {
  const col = await getCollection();
  const doc = await col.findOne({ _id: STATE_ID });

  if (!doc || !Array.isArray(doc.debts)) {
    return [];
  }

  // ⬅️ السحابة تطغى دائمًا
  saveLocal(doc.debts);
  return doc.debts;
}

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

/* =========================
   Auto sync (safe)
   ========================= */
async function autoSync(debts) {
  try {
    saveLocal(debts);      // cache
    await syncToCloud(debts); // cloud
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* =========================
   Force sync (manual button)
   ========================= */
async function forceSync(debts) {
  saveLocal(debts);
  await syncToCloud(debts);
  return { ok: true };
}

module.exports = {
  loadLocal,
  saveLocal,
  loadCloud,
  autoSync,
  forceSync
};
