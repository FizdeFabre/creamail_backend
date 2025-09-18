import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// --- Config ---
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testPixel() {
  try {
    // 🔹 Étape 1 : Créer une entrée email_sent bidon
    const { data: inserted, error } = await supabaseAdmin
      .from("emails_sent")
      .insert({
        sequence_id: "test-sequence-123", // n’importe quelle valeur
        to_email: "fake@test.com",
        sent_at: new Date().toISOString(),
        opened: false,
        clicked: false,
        responded: false,
        variant: "A"
      })
      .select()
      .single();

    if (error) throw new Error("Insert error: " + error.message);
    console.log("✅ Email log inséré avec ID:", inserted.id);

    // 🔹 Étape 2 : Appeler ton pixel tracker
    const pixelUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/api/open?id=${inserted.id}`;
    console.log("📡 Requête vers:", pixelUrl);

    const res = await fetch(pixelUrl);
    console.log("📥 Status pixel:", res.status);

    // 🔹 Étape 3 : Vérifier en DB si opened = true
    const { data: updated, error: selError } = await supabaseAdmin
      .from("emails_sent")
      .select("id, opened, opened_at")
      .eq("id", inserted.id)
      .single();

    if (selError) throw new Error("Select error: " + selError.message);

    console.log("📊 État final en DB:", updated);

  } catch (err) {
    console.error("❌ Test pixel error:", err.message);
  }
}

testPixel();