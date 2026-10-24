// Sends a lab report / invoice PDF to a patient through the official WhatsApp Cloud API.
// Only signed-in lab members can call it. The WhatsApp token never reaches the browser.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const GRAPH = "https://graph.facebook.com/v21.0";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  // 1) caller must be a signed-in lab member
  const auth = req.headers.get("Authorization") || "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: member, error: memErr } = await sb.rpc("is_lab_member");
  if (memErr || member !== true) return json({ ok: false, error: "not_member" }, 403);

  // 2) WhatsApp settings (stored as secrets in Supabase)
  const token = Deno.env.get("WHATSAPP_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_ID");
  const template = Deno.env.get("WHATSAPP_TEMPLATE") || "lab_result_ready";
  const lang = Deno.env.get("WHATSAPP_LANG") || "ar";
  if (!token || !phoneId) return json({ ok: false, error: "not_configured" });

  let body: { to?: string; name?: string; fileName?: string; pdfBase64?: string; test?: boolean };
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_body" }, 400); }
  if (body.test) return json({ ok: true, configured: true });

  const to = String(body.to || "").replace(/\D/g, "");
  if (to.length < 9) return json({ ok: false, error: "bad_number" });
  if (!body.pdfBase64) return json({ ok: false, error: "no_file" });
  const fileName = String(body.fileName || "Misk-Lab-Report.pdf").replace(/[^A-Za-z0-9._-]/g, "-");

  // 3) upload the PDF to WhatsApp
  const bytes = Uint8Array.from(atob(body.pdfBase64), (c) => c.charCodeAt(0));
  if (bytes.length > 15 * 1024 * 1024) return json({ ok: false, error: "file_too_big" });
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", new Blob([bytes], { type: "application/pdf" }), fileName);
  const up = await fetch(`${GRAPH}/${phoneId}/media`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const upJson = await up.json().catch(() => ({}));
  if (!up.ok || !upJson.id) return json({ ok: false, error: "upload_failed", detail: upJson?.error?.message || up.status });

  // 4) send the approved template with the PDF attached
  const msg = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template,
      language: { code: lang },
      components: [
        { type: "header", parameters: [{ type: "document", document: { id: upJson.id, filename: fileName } }] },
        { type: "body", parameters: [{ type: "text", text: String(body.name || "").slice(0, 60) || "عزيزي المراجع" }] },
      ],
    },
  };
  const send = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  const sendJson = await send.json().catch(() => ({}));
  if (!send.ok) return json({ ok: false, error: "send_failed", detail: sendJson?.error?.message || send.status, code: sendJson?.error?.code });
  return json({ ok: true, messageId: sendJson?.messages?.[0]?.id || null, to });
});
