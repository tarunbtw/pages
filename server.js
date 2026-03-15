require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const path      = require("path");
const crypto    = require("crypto");
const Razorpay  = require("razorpay");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Supabase ──────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

    // Save pending record to Supabase
    const { error } = await supabase.from("registrations").insert({
      team_name:          team_name.trim(),
      leader_name:        leader_name.trim(),
      email:              email.trim().toLowerCase(),
      phone:              phone.trim(),
      razorpay_order_id:  order.id,
      amount,
      status:             "pending",
    });

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ success: false, error: "Could not save registration." });
    }

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

  // Check order exists in Supabase
  const { data, error } = await supabase
    .from("registrations")
    .select("id, status")
    .eq("razorpay_order_id", razorpay_order_id)
    .single();

  if (error || !data) {
    console.warn("⚠️ Unknown order_id:", razorpay_order_id);
    return res.status(404).json({ success: false, error: "Order not found." });
  }

  if (data.status === "paid") {
    return res.status(409).json({ success: false, error: "Order already paid." });
  }

  // HMAC signature verification
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

  // Double check with Razorpay API
  const payment = await razorpay.payments.fetch(razorpay_payment_id);
  if (payment.status !== "captured") {
    console.error(`🚨 Payment not captured — status: ${payment.status}`);
    return res.status(400).json({ success: false, error: "Payment not completed." });
  }

  // Mark as paid in Supabase
  const { error: updateError } = await supabase
    .from("registrations")
    .update({
      status:              "paid",
      razorpay_payment_id: razorpay_payment_id,
      paid_at:             new Date().toISOString(),
    })
    .eq("razorpay_order_id", razorpay_order_id);

  if (updateError) {
    console.error("Supabase update error:", updateError);
    return res.status(500).json({ success: false, error: "Could not update payment status." });
  }

  console.log(`✅ Payment verified: ${razorpay_payment_id}`);

  return res.json({
    success:      true,
    redirect_url: process.env.SUCCESS_REDIRECT_URL,
  });
});

// ── Start ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});