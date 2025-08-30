// server.js
import express from "express";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const CRON_SECRET = process.env.CRON_SECRET || ""; // optionnel

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────
function buildTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.FROM_EMAIL,
      pass: process.env.EMAIL_PASS, // ⚠️ mot de passe d'application Gmail
    },
  });
}

/**
 * Incrémente une date ISO UTC selon une récurrence donnée.
 * Garantit que le résultat est STRICTEMENT dans le futur vs nowUTC.
 */
function calculateNextDate(scheduledAtISO, recurrence) {
  if (!scheduledAtISO) return null;
  const inc = (d) => {
    switch (recurrence) {
      case "daily":   d.setUTCDate(d.getUTCDate() + 1); break;
      case "weekly":  d.setUTCDate(d.getUTCDate() + 7); break;
      case "monthly": d.setUTCMonth(d.getUTCMonth() + 1); break;
      case "yearly":  d.setUTCFullYear(d.getUTCFullYear() + 1); break;
      default: return null;
    }
    return d;
  };

  const now = new Date(); // UTC by toISOString reference
  let next = new Date(scheduledAtISO);
  if (Number.isNaN(next.getTime())) return null;

  // Si la date est déjà passée (ou égale), on push jusqu'à dépasser "now"
  while (next <= now) {
    const bumped = inc(next);
    if (!bumped) return null;
    next = bumped;
  }
  return next.toISOString();
}

// ─────────────────────────────────────────────────────────────
// CRON job
// ─────────────────────────────────────────────────────────────
async function processOnce(batchSize = 50) {
  const now = new Date().toISOString();
  console.log("🔹 CRON START", now);

  // 1) Séquences prêtes (UTC) et encore "pending"
  const { data: sequences, error: seqError } = await supabaseAdmin
    .from("email_sequences")
    .select("*")
    .lte("scheduled_at", now)
    .eq("status", "pending");

  if (seqError) {
    console.error("❌ Fetch sequences error:", seqError.message);
    return { sent: 0, error: seqError.message };
  }

  console.log("📬 Sequences found:", sequences?.length || 0);
  if (!sequences?.length) return { sent: 0, info: "No sequences to send" };

  const transporter = buildTransporter();
  let sentCount = 0;

  for (const sequence of sequences) {
    try {
      console.log("➡️ Processing sequence:", sequence.id, "| subject:", sequence.subject, "| scheduled_at:", sequence.scheduled_at);

      // 2) Lock optimiste : on ne passe en "sending" QUE si toujours "pending"
      const { error: lockError, count } = await supabaseAdmin
        .from("email_sequences")
        .update({ status: "sending" })
        .eq("id", sequence.id)
        .eq("status", "pending")
        .select("*", { count: "exact", head: true });

      if (lockError) {
        console.warn("⚠️ Could not lock sequence:", sequence.id, lockError.message);
        continue;
      }
      if (!count) {
        console.warn("⚠️ Sequence already locked/processed:", sequence.id);
        continue;
      }

      // 3) Destinataires
      const { data: recipients, error: recError } = await supabaseAdmin
        .from("sequence_recipients")
        .select("to_email")
        .eq("sequence_id", sequence.id);

      if (recError) {
        console.warn("⚠️ Recipients fetch error:", recError.message);
        // repasse en pending pour retenter plus tard
        await supabaseAdmin.from("email_sequences").update({ status: "pending" }).eq("id", sequence.id);
        continue;
      }

      const list = Array.isArray(recipients) ? recipients : [];
      console.log("👥 Recipients found:", list.length);

      if (!list.length) {
        console.warn("⚠️ No recipients for sequence:", sequence.id);
        await supabaseAdmin.from("email_sequences").update({ status: "error", error_message: "No recipients" }).eq("id", sequence.id);
        continue;
      }

      // 4) Envoi en batch
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);

        await Promise.all(batch.map(async (r) => {
          const to = (r?.to_email || "").trim();
          if (!to || !to.includes("@")) return;

          console.log(`✉️ Sending to: ${to}`);

          // log d'envoi (tracking/pixel)
          const { data: inserted, error: insErr } = await supabaseAdmin
            .from("emails_sent")
            .insert({ sequence_id: sequence.id, to_email: to })
            .select()
            .single();

          if (insErr || !inserted) {
            console.warn("⚠️ Failed to log email for:", to, insErr?.message);
            return;
          }

          const pixelUrl = process.env.OPEN_PIXEL_URL
            ? `${process.env.OPEN_PIXEL_URL}?id=${inserted.id}`
            : null;

          const html =
            pixelUrl
              ? `${sequence.body}<br><img src="${pixelUrl}" width="1" height="1" />`
              : sequence.body;

          try {
            const info = await transporter.sendMail({
              from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
              to,
              subject: sequence.subject,
              html,
            });
            console.log("✅ Mail sent:", info.messageId);
            sentCount++;
          } catch (e) {
            console.error("❌ Mail send error to", to, e?.message || e);
          }
        }));

        // petite pause anti-spam
        await new Promise((r) => setTimeout(r, 200));
      }

      // 5) Récurrence / statut
      if (sequence.recurrence === "once") {
        await supabaseAdmin
          .from("email_sequences")
          .update({ status: "completed" })
          .eq("id", sequence.id);
        console.log("🟢 Sequence completed:", sequence.id);
      } else {
        const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
        if (!nextDate) {
          console.warn("⚠️ Could not compute next date, marking completed:", sequence.id);
          await supabaseAdmin.from("email_sequences").update({ status: "completed" }).eq("id", sequence.id);
        } else {
          await supabaseAdmin
            .from("email_sequences")
            .update({ scheduled_at: nextDate, status: "pending" })
            .eq("id", sequence.id);
          console.log("🌀 Sequence rescheduled:", nextDate);
        }
      }
    } catch (err) {
      console.error("❌ Unexpected error on sequence", sequence.id, err?.message || err);
      // en cas de crash séquence spécifique, on remet en pending pour retenter plus tard
      await supabaseAdmin.from("email_sequences").update({ status: "pending" }).eq("id", sequence.id);
    }
  }

  console.log("📈 CRON END, total emails sent:", sentCount);
  return { sent: sentCount };
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Backend EchoNotes OK 🚀"));

app.get("/cron/run", async (req, res) => {
  try {
    if (CRON_SECRET) {
      const key = req.query.key || req.headers["x-cron-key"];
      if (key !== CRON_SECRET) {
        console.warn("🔒 CRON forbidden: bad key");
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
    }
    console.log("🚀 CRON RUN triggered at", new Date().toISOString());
    const result = await processOnce();
    console.log("📊 Process result:", result);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("❌ Cron error:", err.message || err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/testmail", async (req, res) => {
  try {
    const to = process.env.TEST_EMAIL || process.env.FROM_EMAIL;
    const transporter = buildTransporter();
    const info = await transporter.sendMail({
      from: `"EchoNotes Test" <${process.env.FROM_EMAIL}>`,
      to,
      subject: "✅ Test Email from EchoNotes",
      text: "Coucou, ton backend fonctionne 🎉",
    });
    console.log("✅ Test mail sent:", info.messageId, "→", to);
    res.json({ ok: true, messageId: info.messageId, to });
  } catch (err) {
    console.error("❌ Test mail error:", err.message || err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));