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
      pass: process.env.EMAIL_PASS   // ⚠️ mot de passe d’application Gmail
    },
  });
}

export async function processOnce(batchSize = 50) {
  const now = new Date().toISOString();

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
    // 🔒 Lock
    const { error: lockError } = await supabaseAdmin
      .from("email_sequences")
      .update({ status: "sending" })
      .eq("id", sequence.id)
      .eq("status", "pending");

    if (lockError) continue;

    const { data: recipients } = await supabaseAdmin
      .from("sequence_recipients")
      .select("to_email")
      .eq("sequence_id", sequence.id);

    if (!recipients?.length) continue;

    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);

      await Promise.all(batch.map(async r => {
        const to = r.to_email;
        if (!to?.includes("@")) return;

        const { data: inserted } = await supabaseAdmin
          .from("emails_sent")
          .insert({ sequence_id: sequence.id, to_email: to })
          .select()
          .single();

        if (!inserted) return;

        const pixelUrl = `https://tondomaine.com/api/open?id=${inserted.id}`;
        const html = `${sequence.body}<br><img src="${pixelUrl}" width="1" height="1" />`;

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

      await new Promise(r => setTimeout(r, 200)); // pause anti-spam
    }

    // 🌀 Update récurrence
    if (sequence.recurrence === "once") {
      await supabaseAdmin.from("email_sequences").update({ status: "completed" }).eq("id", sequence.id);
    } else {
      const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
      if (nextDate) {
        await supabaseAdmin
          .from("email_sequences")
          .update({ scheduled_at: nextDate, status: "pending" })
          .eq("id", sequence.id);
      }
    }
  }

  return { sent: sentCount };
}