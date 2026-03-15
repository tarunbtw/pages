require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const path      = require("path");
const fs        = require("fs");
const crypto    = require("crypto");
const initSqlJs = require("sql.js");
const Razorpay  = require("razorpay");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Razorpay ──────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── Routes ────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/create-order", async (req, res) => {
  const { team_name, leader_name, email, phone } = req.body;

  if (!team_name || !leader_name || !email || !phone) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }

  // Validate phone — must be +91 followed by 10 digits
  if (!/^\+91\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, error: "Invalid phone number." });
  }

  try {
    const amount = parseInt(process.env.REGISTRATION_AMOUNT, 10);

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `MINISIH_${Date.now()}`,
    });

    db.run(
      `INSERT INTO registrations (team_name, leader_name, email, phone, razorpay_order_id, amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [team_name.trim(), leader_name.trim(), email.trim().toLowerCase(), phone.trim(), order.id, amount]
    );
    saveDatabase();

    return res.json({
      success:  true,
      order_id: order.id,
      amount,
      key_id:   process.env.RAZORPAY_KEY_ID,
    });

  } catch (err) {
    console.error("create-order error:", err);
    return res.status(500).json({ success: false, error: "Could not create order." });
  }
});

app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: "Missing payment fields." });
  }

  const rows = db.exec(
    `SELECT id, status FROM registrations WHERE razorpay_order_id = ? LIMIT 1`,
    [razorpay_order_id]
  );
  if (!rows.length || !rows[0].values.length) {
    console.warn("⚠️ Unknown order_id:", razorpay_order_id);
    return res.status(404).json({ success: false, error: "Order not found." });
  }

  const status = rows[0].values[0][1];

  if (status === "paid") {
    return res.status(409).json({ success: false, error: "Order already paid." });
  }

  const body     = razorpay_order_id + "|" + razorpay_payment_id;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  const isValid = crypto.timingSafeEqual(
    Buffer.from(razorpay_signature, "hex"),
    Buffer.from(expected, "hex")
  );

  if (!isValid) {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    console.error(`🚨 FAKE PAYMENT ATTEMPT — IP: ${ip}, order: ${razorpay_order_id}`);
    return res.status(400).json({ success: false, error: "Payment verification failed." });
  }

  db.run(
    `UPDATE registrations
     SET status = 'paid', razorpay_payment_id = ?, paid_at = datetime('now')
     WHERE razorpay_order_id = ?`,
    [razorpay_payment_id, razorpay_order_id]
  );
  saveDatabase();

  console.log(`✅ Payment verified: ${razorpay_payment_id}`);

  return res.json({
    success:      true,
    redirect_url: process.env.SUCCESS_REDIRECT_URL,
  });
});

// ── Database ──────────────────────────────────────
const DB_PATH = path.join(__dirname, "db", "registrations.json");
let db;

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    const data = JSON.parse(fileBuffer.toString());
    db = new SQL.Database(new Uint8Array(data));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS registrations (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      team_name           TEXT NOT NULL,
      leader_name         TEXT NOT NULL,
      email               TEXT NOT NULL,
      phone               TEXT NOT NULL,
      razorpay_order_id   TEXT UNIQUE NOT NULL,
      razorpay_payment_id TEXT UNIQUE,
      amount              INTEGER NOT NULL,
      status              TEXT DEFAULT 'pending',
      created_at          TEXT DEFAULT (datetime('now')),
      paid_at             TEXT
    )
  `);

  saveDatabase();
  console.log("✅ Database ready");
}

function saveDatabase() {
  const data = db.export();
  fs.mkdirSync(path.join(__dirname, "db"), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(Array.from(data)));
}

// ── Start ─────────────────────────────────────────
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});