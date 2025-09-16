import nodemailer from "nodemailer";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

function calculateNextDate(current, recurrence) {
  const d = new Date(current);
  switch (recurrence) {
    case "daily":   d.setUTCDate(d.getUTCDate() + 1); break;
    case "weekly":  d.setUTCDate(d.getUTCDate() + 7); break;
    case "monthly": d.setUTCMonth(d.getUTCMonth() + 1); break;
    case "yearly":  d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: return null;
  }
  return d.toISOString();
}

function buildTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { 
      user: process.env.FROM_EMAIL, 
      pass: process.env.EMAIL_PASS 
    },
  });
}

export async function processOnce(batchSize = 50) {
  const now = new Date().toISOString();

  // 👉 récupérer les séquences prêtes
  const { data: sequences, error: seqError } = await supabaseAdmin
    .from("email_sequences")
    .select("*")
    .lte("scheduled_at", now)
    .eq("status", "pending");

  if (seqError) throw new Error("Fetch sequences error: " + seqError.message);
  if (!sequences?.length) return { sent: 0, info: "No sequences" };

  const transporter = buildTransporter();
  let sentCount = 0;

  for (const sequence of sequences) {
    console.log("➡️ Processing sequence:", sequence_id);

    // 🔒 Lock sur sequence_id au lieu de id
    const { error: lockError } = await supabaseAdmin
      .from("email_sequences")
      .update({ status: "sending" })
      .eq("sequence_id", sequence_id)
      .eq("status", "pending");

    if (lockError) {
      console.error("⚠️ Could not lock sequence:", lockError.message);
      continue;
    }

    // 👉 Destinataires
    const { data: recipients } = await supabaseAdmin
      .from("sequence_recipients")
      .select("to_email")
      .eq("sequence_id", sequence_id);

    if (!recipients?.length) continue;

    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);

      await Promise.all(batch.map(async r => {
        const to = r.to_email;
        if (!to?.includes("@")) return;

        // 👉 insérer l'email envoyé
        const { data: inserted, error: insertError } = await supabaseAdmin
          .from("emails_sent")
          .insert({
            sequence_id: sequence_id,
            to_email: to,
            sent_at: new Date().toISOString(),
            opened: false,
            clicked: false,
            responded: false,
            variant: "A"
          })
          .select()
          .single();

        if (insertError) {
          console.error("❌ Failed to insert sent email:", insertError.message);
          return;
        }

        const pixelUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/open?id=${inserted.id}`;
        const html = `${sequence.body}<br><img src="${pixelUrl}" width="1" height="1" style="display:none;" />`;

        try {
          await transporter.sendMail({
            from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
            to,
            subject: sequence.subject,
            html,
          });
          sentCount++;
        } catch (e) {
          console.error("Mail error:", e.message);
        }
      }));

      await new Promise(r => setTimeout(r, 200)); // throttle anti-spam
    }

    // 🌀 Update récurrence
    if (sequence.recurrence === "once") {
      await supabaseAdmin
        .from("email_sequences")
        .update({ status: "completed" })
        .eq("sequence_id", sequence_id);
    } else {
      const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
      if (nextDate) {
        await supabaseAdmin
          .from("email_sequences")
          .update({ scheduled_at: nextDate, status: "pending" })
          .eq("sequence_id", sequence_id);
      }
    }
  }

  console.log("📈 CRON END, total emails sent:", sentCount);
  return { sent: sentCount };
}