import { createClient } from "npm:@supabase/supabase-js@2";
import { importPKCS8, SignJWT } from "npm:jose@5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse(405, { message: "Method not allowed" });

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return jsonResponse(401, { message: "Authentication required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const signingKey = Deno.env.get("LICENSE_SIGNING_PRIVATE_KEY");
  if (!supabaseUrl || !publishableKey || !signingKey) {
    return jsonResponse(503, { message: "License validation is not configured" });
  }

  try {
    const supabase = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse(401, { message: "Authentication required" });

    const [profileResult, licenseResult] = await Promise.all([
      supabase.from("profiles").select("customer_id, shop_id").eq("id", userData.user.id).maybeSingle(),
      supabase.from("licenses").select("id, status, expires_at").eq("profile_id", userData.user.id).maybeSingle(),
    ]);

    const profile = profileResult.data;
    const license = licenseResult.data;
    if (profileResult.error || licenseResult.error || !profile || !license) {
      return jsonResponse(403, { status: "pending", message: "Your license is awaiting approval." });
    }

    const now = Math.floor(Date.now() / 1000);
    const licenseExpiry = license.expires_at
      ? Math.floor(new Date(license.expires_at).getTime() / 1000)
      : null;
    const expired = licenseExpiry !== null && Number.isFinite(licenseExpiry) && licenseExpiry <= now;
    const status = license.status === "active" && !expired
      ? "active"
      : license.status === "pending" ? "pending" : "deactivated";

    const offlineUntil = now + 60;
    const privateKeyPem = signingKey.replaceAll("\\n", "\n");
    const privateKey = await importPKCS8(privateKeyPem, "ES256");
    const entitlement = await new SignJWT({
      customer_id: profile.customer_id,
      shop_id: profile.shop_id,
      license_id: license.id,
      status,
      license_expires_at: license.expires_at,
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer("huzaifa-bytes-license")
      .setSubject(userData.user.id)
      .setIssuedAt(now)
      .setExpirationTime(offlineUntil)
      .sign(privateKey);

    return jsonResponse(200, {
      entitlement,
      status,
      message: status === "active" ? "License active" : `This shop license is ${status}.`,
    });
  } catch (error) {
    console.error("License validation failed", error);
    return jsonResponse(503, { message: "Unable to validate this license right now" });
  }
});