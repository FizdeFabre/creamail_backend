import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return new Response("Missing email id", { status: 400 });
  }

  try {
    await supabaseAdmin
      .from("emails_sent")
      .update({ opened: true, opened_at: new Date().toISOString() })
      .eq("id", id);

    // pixel 1x1 transparent
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8HwQACfsD/QkEZHcAAAAASUVORK5CYII=",
      "base64"
    );

    return new Response(pixel, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": pixel.length,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Expires": "0",
        "Pragma": "no-cache",
      },
    });
  } catch (e) {
    console.error("❌ Pixel route error:", e.message);
    return new Response("Server error", { status: 500 });
  }
}