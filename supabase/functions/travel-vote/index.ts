import { createClient } from "npm:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2.4.3";

const encoder = new TextEncoder();
const allowedGenders = new Set(["lover", "cd", "mtf", "tg"]);
const pollSlugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

function allowedPollSlugs() {
  // Keep the allowlist on the server: poll slugs sent by a browser are public,
  // so client-side validation alone cannot prevent writes to arbitrary polls.
  const configured = Deno.env.get("VOTE_ALLOWED_POLL_SLUGS") ?? "daebudo-2026-autumn";
  return new Set(configured.split(",").map((value) => value.trim()).filter(Boolean));
}

function readPollSlug(body: Record<string, unknown>) {
  const pollSlug = typeof body.pollSlug === "string" ? body.pollSlug : "";
  return pollSlugPattern.test(pollSlug) && allowedPollSlugs().has(pollSlug) ? pollSlug : "";
}

function response(payload: Record<string, unknown>, status: number, cors: HeadersInit) {
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

function corsHeaders(request: Request): Headers | null {
  const origin = request.headers.get("origin") ?? "";
  const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "";
  const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!origin || (!localOrigin && origin !== allowedOrigin)) return null;
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  });
}

async function hashRateLimitIdentifier(request: Request) {
  const ip = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? "unknown";
  const pepper = Deno.env.get("RATE_LIMIT_PEPPER") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${pepper}:${ip}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function defaultSupabaseSecretKey() {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return legacyKey;
  try {
    return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? "";
  } catch {
    return "";
  }
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request);
  if (!cors) return response({ error: "허용되지 않은 출처입니다." }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return response({ error: "POST 요청만 허용됩니다." }, 405, cors);

  const serviceUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = defaultSupabaseSecretKey();
  const masterPasswordHash = Deno.env.get("VOTE_MASTER_PASSWORD_HASH");
  if (!serviceUrl || !serviceRole || !masterPasswordHash) {
    return response({ error: "서버 보안 설정이 완료되지 않았습니다." }, 503, cors);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return response({ error: "잘못된 요청 형식입니다." }, 400, cors);
  }

  const action = body.action;
  if (action !== "create" && action !== "delete-own" && action !== "delete-admin") {
    return response({ error: "지원하지 않는 요청입니다." }, 400, cors);
  }

  const supabase = createClient(serviceUrl, serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const identifierHash = await hashRateLimitIdentifier(request);
  const pollSlug = readPollSlug(body);
  if (!pollSlug) return response({ error: "이 여행 투표는 현재 열려 있지 않습니다." }, 400, cors);
  const bucket = action === "create" ? "create" : "delete";
  const rateLimit = await supabase.rpc("consume_vote_rate_limit", {
    p_bucket: bucket,
    p_identifier_hash: identifierHash,
  });
  if (rateLimit.error) return response({ error: "요청 확인 중 오류가 발생했습니다." }, 500, cors);
  if (!rateLimit.data) return response({ error: "요청이 너무 많습니다. 한 시간 뒤에 다시 시도해 주세요." }, 429, cors);

  if (action === "create") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const gender = typeof body.gender === "string" ? body.gender : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || name.length > 40 || /[\u0000-\u001F\u007F]/.test(name) || !allowedGenders.has(gender) || encoder.encode(password).length < 4 || encoder.encode(password).length > 72) {
      return response({ error: "이름, 성별 분류, 4~72바이트 비밀번호를 확인해 주세요." }, 400, cors);
    }
    const result = await supabase.rpc("submit_vote", {
      p_name: name,
      p_gender: gender,
      p_password: password,
      p_poll_slug: pollSlug,
    });
    if (result.error) return response({ error: "투표를 저장하지 못했습니다. 입력값을 확인해 주세요." }, 400, cors);
    return response({ voteId: result.data }, 201, cors);
  }

  const password = typeof body.password === "string" ? body.password : "";

  if (action === "delete-own") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || !password) return response({ error: "투표한 이름과 비밀번호를 확인해 주세요." }, 400, cors);
    const result = await supabase.rpc("delete_vote_by_name_and_password", {
      p_name: name,
      p_password: password,
      p_poll_slug: pollSlug,
    });
    if (result.error) return response({ error: "삭제 요청을 처리하지 못했습니다." }, 500, cors);
    if (!result.data) return response({ error: "이름 또는 비밀번호가 일치하지 않습니다." }, 403, cors);
    return response({ deleted: true }, 200, cors);
  }

  const voteId = body.voteId;
  if (!isUuid(voteId) || !password) return response({ error: "투표번호와 비밀번호를 확인해 주세요." }, 400, cors);

  if (!bcrypt.compareSync(password, masterPasswordHash)) {
    return response({ error: "마스터 비밀번호가 일치하지 않습니다." }, 403, cors);
  }
  const result = await supabase.rpc("admin_delete_vote", { p_vote_id: voteId, p_poll_slug: pollSlug });
  if (result.error) return response({ error: "삭제 요청을 처리하지 못했습니다." }, 500, cors);
  if (!result.data) return response({ error: "이미 삭제됐거나 존재하지 않는 투표입니다." }, 404, cors);
  return response({ deleted: true }, 200, cors);
});
