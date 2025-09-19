import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

export async function GET() {
  try {
    const now = new Date().toISOString();

    // Récupérer les séquences prêtes
    const { data: sequences, error: seqErr } = await supabaseAdmin
      .from("email_sequences")
      .select("*")
      .lte("scheduled_at", now)
      .eq("status", "pending");

    if (seqErr) throw new Error(seqErr.message);
    if (!sequences?.length) {
      return new Response(JSON.stringify({ sent: 0, info: "No sequences" }), { status: 200 });
    }

    const transporter = buildTransporter();
    let sentCount = 0;

    for (const sequence of sequences) {
      console.log("➡️ Processing sequence:", sequence.sequence_id);

      // Récupérer les destinataires
      const { data: recipients, error: recErr } = await supabaseAdmin
        .from("sequence_recipients")
        .select("to_email")
        .eq("sequence_id", sequence.sequence_id);

      if (recErr) {
        console.error("❌ Fetch recipients error:", recErr.message);
        continue;
      }
      if (!recipients?.length) continue;

      for (const r of recipients) {
        const to = r.to_email;
        if (!to?.includes("@")) continue;

        // Pixel URL
        const htmlPixel = async (insertedId, body) => {
          const pixelUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/open?id=${insertedId}`;
          return `${body}<br><img src="${pixelUrl}" width="1" height="1" style="display:none;" />`;
        };

        try {
          // Envoyer le mail
          const info = await transporter.sendMail({
            from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
            to,
            subject: sequence.subject,
            html: sequence.body // on met le pixel après l'insertion dans emails_sent
          });

          // Insérer l'email dans emails_sent **après envoi**
          const { data: inserted, error: insertErr } = await supabaseAdmin
            .from("emails_sent")
            .insert({
              sequence_id: sequence.sequence_id,
              to_email: to,
              sent_at: new Date().toISOString(),
              opened: false,
              clicked: false,
              responded: false,
              variant: "A"
            })
            .select()
            .single();

          if (insertErr) {
            console.error("❌ Failed to log email:", insertErr.message);
            continue;
          }

          // Ajouter le pixel dans l'email envoyé
          const htmlWithPixel = await htmlPixel(inserted.id, sequence.body);
          await transporter.sendMail({
            from: `"EchoNotes" <${process.env.FROM_EMAIL}>`,
            to,
            subject: sequence.subject,
            html: htmlWithPixel
          });

          sentCount++;
          console.log("✅ Mail sent:", info.messageId);

        } catch (e) {
          console.error("❌ Mail send error to", to, e?.message);
        }
      }

      // Update récurrence
      if (sequence.recurrence === "once") {
        await supabaseAdmin
          .from("email_sequences")
          .update({ status: "completed" })
          .eq("sequence_id", sequence.sequence_id);
      } else {
        const nextDate = calculateNextDate(sequence.scheduled_at, sequence.recurrence);
        if (nextDate) {
          await supabaseAdmin
            .from("email_sequences")
            .update({ scheduled_at: nextDate, status: "pending" })
            .eq("sequence_id", sequence.sequence_id);
        }
      }
    }

    console.log("📈 CRON END, total emails sent:", sentCount);
    return new Response(JSON.stringify({ ok: true, sent: sentCount }), { status: 200 });

  } catch (err) {
    console.error("❌ Cron error:", err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
}

// --- Pixel API ---
export async function GET_OPEN(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing email id");

  try {
    await supabaseAdmin
      .from("emails_sent")
      .update({ opened: true, opened_at: new Date().toISOString() })
      .eq("id", id);

    res.setHeader("Content-Type", "image/png");
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8HwQACfsD/QkEZHcAAAAASUVORK5CYII=",
      "base64"
    );
    res.send(pixel);

  } catch (e) {
    console.error("❌ Pixel route error:", e.message);
    res.status(500).send("Server error");
  }
}