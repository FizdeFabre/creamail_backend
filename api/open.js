import { supabaseAdmin } from "../utils/supabase";

export async function GET(req, res) {
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
  } catch (err) {
    console.error("❌ Pixel tracker error:", err.message);
    res.status(500).send("Server error");
  }
}