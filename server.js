require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const helmet   = require("helmet");
const path     = require("path");
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

// ── Routes ────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Step 1 — Save registration details
app.post("/register", async (req, res) => {
  const { team_name, leader_name, email, phone } = req.body;

  if (!team_name || !leader_name || !email || !phone) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }

  if (!/^\+91\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, error: "Invalid phone number." });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: "Invalid email address." });
  }

  try {
    // Check for duplicate email
    const { data: existing } = await supabase
      .from("registrations")
      .select("id, status")
      .eq("email", email.trim().toLowerCase())
      .single();

    if (existing) {
      if (existing.status === "paid") {
        return res.status(409).json({ success: false, error: "This email is already registered and verified." });
      }
      // Pending — let them continue
      return res.json({ success: true, registration_id: existing.id });
    }

    const { data, error } = await supabase
      .from("registrations")
      .insert({
        team_name:   team_name.trim(),
        leader_name: leader_name.trim(),
        email:       email.trim().toLowerCase(),
        phone:       phone.trim(),
        amount:      120000,
        status:      "pending",
      })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ success: false, error: "Could not save registration." });
    }

    console.log(`✅ Registration saved: ${data.id} — ${team_name}`);
    return res.json({ success: true, registration_id: data.id });

  } catch (err) {
    console.error("register error:", err);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// Step 2 — Save UTR number after user pays
app.post("/submit-utr", async (req, res) => {
  const { registration_id, utr_number } = req.body;

  if (!registration_id || !utr_number) {
    return res.status(400).json({ success: false, error: "Registration ID and UTR number are required." });
  }

  if (!/^[a-zA-Z0-9]{6,22}$/.test(utr_number.trim())) {
    return res.status(400).json({ success: false, error: "Invalid UTR number format." });
  }

  try {
    const { data, error } = await supabase
      .from("registrations")
      .select("id, status")
      .eq("id", registration_id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: "Registration not found." });
    }

    if (data.status === "paid") {
      return res.status(409).json({ success: false, error: "This registration is already verified." });
    }

    // Prevent duplicate UTR
    const { data: dupUTR } = await supabase
      .from("registrations")
      .select("id")
      .eq("utr_number", utr_number.trim())
      .single();

    if (dupUTR && dupUTR.id !== registration_id) {
      console.error(`🚨 Duplicate UTR: ${utr_number} — reg: ${registration_id}`);
      return res.status(409).json({ success: false, error: "This UTR number has already been used." });
    }

    const { error: updateError } = await supabase
      .from("registrations")
      .update({
        utr_number: utr_number.trim(),
        status:     "utr_submitted",
      })
      .eq("id", registration_id);

    if (updateError) {
      console.error("Supabase update error:", updateError);
      return res.status(500).json({ success: false, error: "Could not save UTR." });
    }

    console.log(`✅ UTR submitted: ${utr_number} for reg ${registration_id}`);
    return res.json({ success: true });

  } catch (err) {
    console.error("submit-utr error:", err);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── Start ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});