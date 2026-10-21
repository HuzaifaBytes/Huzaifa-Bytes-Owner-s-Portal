import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse(405, { message: "Method not allowed" });

  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return jsonResponse(401, { message: "Authentication required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    return jsonResponse(503, { message: "Installation management is not configured." });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const profileId = typeof body?.profileId === "string" ? body.profileId : "";
    const action = body?.action;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)
      || (action !== "rebind" && action !== "block")) {
      return jsonResponse(400, { message: "Select a valid installation action." });
    }

    const userClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userResult, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userResult.user) return jsonResponse(401, { message: "Authentication required" });

    const { data: profile, error: profileError } = await userClient
      .from("profiles")
      .select("is_admin")
      .eq("id", userResult.user.id)
      .maybeSingle();
    if (profileError || profile?.is_admin !== true) {
      return jsonResponse(403, { message: "Administrator access required." });
    }

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await serviceClient.rpc("update_local_database_binding", {
      p_profile_id: profileId,
      p_action: action,
      p_actor_id: userResult.user.id,
    });
    if (error) {
      console.error("Owner installation action failed", error);
      return jsonResponse(400, { message: "The installation action could not be completed." });
    }

    return jsonResponse(200, { success: true, binding: data });
  } catch (error) {
    console.error("Owner installation action failed", error);
    return jsonResponse(503, { message: "The installation service is unavailable." });
  }
});
