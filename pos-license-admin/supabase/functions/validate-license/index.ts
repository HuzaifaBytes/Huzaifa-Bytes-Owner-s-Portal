import { createClient } from "npm:@supabase/supabase-js@2";
import { importPKCS8, SignJWT } from "npm:jose@5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifyInstallationProof(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const proof = value as Record<string, unknown>;
  if (typeof proof.local_database_identity !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proof.local_database_identity)
    || typeof proof.public_key !== "string"
    || proof.public_key.length > 2048
    || typeof proof.timestamp !== "number"
    || !Number.isSafeInteger(proof.timestamp)
    || Math.abs(Date.now() - proof.timestamp) > 5 * 60 * 1000
    || typeof proof.nonce !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proof.nonce)
    || typeof proof.signature !== "string"
    || proof.signature.length > 256) return null;

  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      decodeBase64Url(proof.public_key),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode(
      `${proof.local_database_identity.toLowerCase()}\n${proof.timestamp}\n${proof.nonce}`,
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decodeBase64Url(proof.signature),
      message,
    );
    return valid ? {
      ldi: proof.local_database_identity.toLowerCase(),
      publicKey: proof.public_key,
      timestamp: proof.timestamp,
      nonce: proof.nonce,
    } : null;
  } catch {
    return null;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse(405, { message: "Method not allowed" });

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return jsonResponse(401, { message: "Authentication required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const signingKey = Deno.env.get("LICENSE_SIGNING_PRIVATE_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey || !signingKey) {
    return jsonResponse(503, { message: "License validation is not configured" });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const installation = await verifyInstallationProof(body?.identityProof);
    if (!installation) {
      return jsonResponse(401, { code: "INSTALLATION_PROOF_INVALID", message: "This installation identity could not be verified." });
    }

    const supabase = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse(401, { message: "Authentication required" });

    const service = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: bindingResult, error: bindingError } = await service.rpc(
      "verify_local_database_identity",
      {
        p_profile_id: userData.user.id,
        p_email: userData.user.email ?? "",
        p_ldi: installation.ldi,
        p_public_key: installation.publicKey,
        p_nonce: installation.nonce,
      },
    );
    if (bindingError) {
      console.error("Installation identity verification failed", bindingError);
      return jsonResponse(503, { message: "Unable to verify this POS installation right now." });
    }
    if (!bindingResult?.allowed) {
      return jsonResponse(409, {
        code: bindingResult?.status === "blocked" ? "INSTALLATION_BLOCKED" : "INSTALLATION_MISMATCH",
        message: bindingResult?.status === "blocked"
          ? "This POS installation has been blocked. Contact your software owner."
          : "This account is registered to another POS installation. Please contact Huzaifa Bytes support or your software owner for device reactivation.",
      });
    }

    const [profileResult, licenseResult, settingsResult] = await Promise.all([
      supabase.from("profiles").select("customer_id, shop_id").eq("id", userData.user.id).maybeSingle(),
      supabase.from("licenses").select("id, status, expires_at, updated_at, deactivated_at").eq("profile_id", userData.user.id).maybeSingle(),
      supabase.from("license_settings").select("offline_grace_days").eq("id", 1).maybeSingle(),
    ]);

    const profile = profileResult.data;
    const license = licenseResult.data;
    if (profileResult.error || licenseResult.error || settingsResult.error || !profile || !license) {
      return jsonResponse(403, { status: "pending", message: "Your license is awaiting approval." });
    }

    const now = Math.floor(Date.now() / 1000);
    const licenseExpiry = license.expires_at === null
      ? null
      : Math.floor(new Date(license.expires_at).getTime() / 1000);
    const invalidExpiry = license.expires_at !== null && !Number.isFinite(licenseExpiry);
    const expired = licenseExpiry !== null && Number.isFinite(licenseExpiry) && licenseExpiry <= now;
    const status = invalidExpiry
      ? "invalid"
      : license.status === "active" && !expired
        ? "active"
        : license.status === "active" && expired
          ? "expired"
          : license.status === "pending"
            ? "pending"
            : license.status === "suspended"
              ? "deactivated"
              : license.status;

    const deactivatedAt = license.status === "suspended" && license.deactivated_at
      ? new Date(license.deactivated_at).toISOString()
      : null;
    const graceUntil = deactivatedAt === null
      ? null
      : Math.floor(Date.parse(deactivatedAt) / 1000) + 12 * 60 * 60;
    const configuredOfflineDays = Number(settingsResult.data?.offline_grace_days ?? 3);
    const offlineGraceSeconds = Math.max(0, Math.min(30, configuredOfflineDays)) * 24 * 60 * 60;
    const activeLeaseUntil = Math.max(now + 60, now + offlineGraceSeconds);
    const offlineUntil = status === "deactivated" && graceUntil !== null
      ? Math.min(graceUntil, now + 12 * 60 * 60)
      : status === "active" && licenseExpiry !== null
        ? Math.min(activeLeaseUntil, licenseExpiry)
        : status === "active"
          ? activeLeaseUntil
          : now + 60;
    const privateKeyPem = signingKey.replaceAll("\\n", "\n");
    const privateKey = await importPKCS8(privateKeyPem, "ES256");
    const entitlement = await new SignJWT({
      customer_id: profile.customer_id,
      shop_id: profile.shop_id,
      license_id: license.id,
      local_database_identity: installation.ldi,
      installation_nonce: installation.nonce,
      status,
      license_expires_at: invalidExpiry ? null : license.expires_at,
      license_updated_at: license.updated_at,
      deactivated_at: deactivatedAt,
      server_time: now,
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