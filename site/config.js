/*
 * This file is intentionally committed. The Supabase project URL and
 * publishable (anon) key identify the public web client; they are not secrets.
 * Do not put a service_role key or an administrator password in this file.
 */
window.TRAVEL_VOTE_CONFIG = Object.freeze({
  supabaseUrl: "https://dudyzvaciywxukspkowx.supabase.co",
  supabasePublishableKey: "sb_publishable_YcV69U_5k-KThCJ4oplvYA_uczO1wn-",
  functionName: "travel-vote",
  // Must also be included in the VOTE_ALLOWED_POLL_SLUGS Edge Function secret.
  pollSlug: "daebudo-2026-autumn",
});
