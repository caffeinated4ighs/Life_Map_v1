/**
 * supabaseClient.js
 * -----------------
 * Initialises and exports the Supabase service-role client.
 * Service role key is used server-side to bypass RLS (correct per AGENTS.md).
 *
 * Owned by: Chat API Agent
 * Referenced by: sessionManager.js, server.js (/health)
 */

import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment."
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/**
 * Lightweight connectivity check used by /health endpoint.
 * Reads a single row from player_state (always exists — seeded at schema init).
 * Returns true if DB is reachable, false otherwise.
 */
export async function checkDbConnectivity() {
  try {
    const { error } = await supabase
      .from("player_state")
      .select("id")
      .limit(1)
      .single();
    return !error;
  } catch {
    return false;
  }
}
