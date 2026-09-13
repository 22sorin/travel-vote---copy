import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const config = window.TRAVEL_VOTE_CONFIG ?? {};
const pollSlug = typeof config.pollSlug === "string" ? config.pollSlug : "";
const configured = Boolean(config.supabaseUrl && config.supabasePublishableKey && config.functionName && pollSlug);
const adminMode = window.location.hash.toLowerCase() === "#admin";
const $ = (selector) => document.querySelector(selector);
const state = { client: null, participants: [], stats: { lover_count: 0, other_count: 0, updated_at: null } };
const labels = { lover: "러버", cd: "CD", mtf: "MTF", tg: "TG" };

const elements = {
  setupNote: $("#setup-note"), status: $("#connection-status"), donut: $("#donut"),
  total: $("#total-count"), loverCount: $("#lover-count"), otherCount: $("#other-count"),
  loverPercent: $("#lover-percent"), otherPercent: $("#other-percent"), loverRatio: $("#lover-ratio"), otherRatio: $("#other-ratio"),
  loverBar: $("#lover-bar"), otherBar: $("#other-bar"), updatedAt: $("#updated-at"),
  peopleCount: $("#people-count"), participantList: $("#participant-list"), emptyPeople: $("#empty-participants"),
  voteForm: $("#vote-form"), voteMessage: $("#vote-message"), ownCard: $("#own-vote-card"),
  ownDeleteForm: $("#own-delete-form"), ownDeleteMessage: $("#own-delete-message"),
  adminConsole: $("#admin-console"), adminForm: $("#admin-delete-form"), adminVoteId: $("#admin-vote-id"), adminMessage: $("#admin-message"), template: $("#participant-template"),
  tabs: [...document.querySelectorAll(".tab")], panels: [...document.querySelectorAll(".tab-panel")], tabShortcut: $(".tab-shortcut"),
};

function selectPanel(panelId, { scroll = true, focus = false } = {}) {
  const panel = elements.panels.find((item) => item.id === panelId);
  const tab = elements.tabs.find((item) => item.dataset.panel === panelId);
  if (!panel || !tab) return;
  elements.tabs.forEach((item) => {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  elements.panels.forEach((item) => { item.hidden = item !== panel; });
  if (focus) tab.focus();
  if (scroll) window.scrollTo({ top: document.querySelector(".tabs").offsetTop, behavior: "smooth" });
}

function setupTabs() {
  const initialPanel = adminMode || window.location.hash === "#vote" || window.location.hash === "#vote-panel"
    ? "vote-panel"
    : "intro-panel";
  selectPanel(initialPanel, { scroll: false });
  elements.tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectPanel(tab.dataset.panel));
    tab.addEventListener("keydown", (event) => {
      const keyMap = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: elements.tabs.length - index - 1 };
      if (!(event.key in keyMap)) return;
      event.preventDefault();
      const nextIndex = (index + keyMap[event.key] + elements.tabs.length) % elements.tabs.length;
      selectPanel(elements.tabs[nextIndex].dataset.panel, { focus: true });
    });
  });
  elements.tabShortcut?.addEventListener("click", () => selectPanel("vote-panel"));
}

function setMessage(target, text = "", type = "") {
  target.textContent = text;
  target.className = `form-message ${type}`.trim();
}

function setButtonBusy(button, busy, idleText) {
  button.disabled = busy;
  button.textContent = busy ? "처리 중…" : idleText;
}

function formatUpdatedAt(value) {
  if (!value) return "아직 투표가 없습니다";
  return `마지막 반영 ${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value))}`;
}

function renderStats(stats) {
  const lover = Number(stats?.lover_count) || 0;
  const other = Number(stats?.other_count) || 0;
  const total = lover + other;
  const loverPct = total ? Math.round((lover / total) * 100) : 0;
  const otherPct = total ? 100 - loverPct : 0;
  state.stats = { lover_count: lover, other_count: other, updated_at: stats?.updated_at ?? null };
  elements.total.textContent = total.toLocaleString("ko-KR");
  elements.loverCount.textContent = `${lover.toLocaleString("ko-KR")}명`;
  elements.otherCount.textContent = `${other.toLocaleString("ko-KR")}명`;
  elements.loverPercent.textContent = `${loverPct}%`;
  elements.otherPercent.textContent = `${otherPct}%`;
  elements.loverRatio.textContent = `${loverPct}%`;
  elements.otherRatio.textContent = `${otherPct}%`;
  elements.loverBar.style.width = `${loverPct}%`;
  elements.otherBar.style.width = `${otherPct}%`;
  elements.donut.style.setProperty("--lover-angle", `${loverPct * 3.6}deg`);
  elements.donut.classList.toggle("empty", total === 0);
  elements.donut.setAttribute("aria-label", `러버 ${loverPct}%, CD·MTF·TG ${otherPct}%, 전체 ${total}명`);
  elements.updatedAt.textContent = formatUpdatedAt(stats?.updated_at);
  elements.peopleCount.textContent = `${total.toLocaleString("ko-KR")}명`;
}

function renderParticipants() {
  elements.participantList.replaceChildren();
  for (const person of state.participants) {
    const fragment = elements.template.content.cloneNode(true);
    const item = fragment.querySelector("li");
    fragment.querySelector("strong").textContent = person.voter_name;
    fragment.querySelector(".person-copy span").textContent = labels[person.gender] ?? person.gender;
    fragment.querySelector(".person-badge").style.background = person.gender === "lover" ? "var(--blue-soft)" : "var(--pink-soft)";
    const adminPick = fragment.querySelector(".admin-pick");
    adminPick.dataset.voteId = person.id;
    adminPick.hidden = !adminMode;
    adminPick.addEventListener("click", () => {
      elements.adminVoteId.value = person.id;
      elements.adminVoteId.focus();
      elements.adminVoteId.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    elements.participantList.append(fragment);
  }
  elements.emptyPeople.hidden = state.participants.length > 0;
}

function replaceParticipant(person) {
  const existing = state.participants.findIndex((item) => item.id === person.id);
  if (existing >= 0) state.participants.splice(existing, 1);
  state.participants.unshift(person);
  state.participants.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  state.participants = state.participants.slice(0, 250);
  renderParticipants();
}

function removeParticipant(id) {
  state.participants = state.participants.filter((person) => person.id !== id);
  renderParticipants();
}

async function callVoteApi(body) {
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, "")}/functions/v1/${config.functionName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: config.supabasePublishableKey },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  return payload;
}

async function loadInitialData() {
  const [statsResult, peopleResult] = await Promise.all([
    state.client.from("vote_stats").select("lover_count, other_count, updated_at").eq("poll_slug", pollSlug).maybeSingle(),
    state.client.from("vote_feed").select("id, voter_name, gender, created_at").eq("poll_slug", pollSlug).order("created_at", { ascending: false }).limit(250),
  ]);
  if (statsResult.error) throw statsResult.error;
  if (peopleResult.error) throw peopleResult.error;
  renderStats(statsResult.data);
  state.participants = peopleResult.data ?? [];
  renderParticipants();
}

function startRealtime() {
  state.client
    .channel(`travel-vote-live-${pollSlug}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "vote_stats", filter: `poll_slug=eq.${pollSlug}` }, (payload) => renderStats(payload.new))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "vote_feed", filter: `poll_slug=eq.${pollSlug}` }, (payload) => replaceParticipant(payload.new))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "vote_feed" }, (payload) => removeParticipant(payload.old.id))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        elements.status.textContent = "실시간 연결됨";
        elements.status.classList.add("connected");
      }
    });
}

elements.voteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) return setMessage(elements.voteMessage, "먼저 Supabase 연결 설정을 완료해 주세요.", "error");
  const form = new FormData(elements.voteForm);
  const name = String(form.get("name") ?? "").trim();
  const gender = String(form.get("gender") ?? "");
  const password = String(form.get("password") ?? "");
  if (!name || !gender || password.length < 4) return setMessage(elements.voteMessage, "이름, 성별, 4자 이상의 비밀번호를 확인해 주세요.", "error");
  const button = elements.voteForm.querySelector("button[type='submit']");
  setButtonBusy(button, true, "투표하기 →");
  setMessage(elements.voteMessage);
  try {
    await callVoteApi({ action: "create", pollSlug, name, gender, password });
    $("#own-delete-name").value = name;
    elements.voteForm.reset();
    setMessage(elements.voteMessage, "투표가 반영됐어요. 비밀번호는 꼭 기억해 주세요.", "success");
  } catch (error) {
    setMessage(elements.voteMessage, error.message, "error");
  } finally {
    setButtonBusy(button, false, "투표하기 →");
  }
});

elements.ownDeleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#own-delete-name").value.trim();
  const password = $("#own-delete-password").value;
  if (!name || password.length < 4) return setMessage(elements.ownDeleteMessage, "투표한 이름과 4자 이상의 비밀번호를 입력해 주세요.", "error");
  const button = elements.ownDeleteForm.querySelector("button");
  setButtonBusy(button, true, "내 투표 삭제");
  try {
    await callVoteApi({ action: "delete-own", pollSlug, name, password });
    $("#own-delete-name").value = "";
    $("#own-delete-password").value = "";
    setMessage(elements.ownDeleteMessage, "내 투표를 삭제했습니다.", "success");
  } catch (error) {
    setMessage(elements.ownDeleteMessage, error.message, "error");
  } finally {
    setButtonBusy(button, false, "내 투표 삭제");
  }
});

elements.adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("#admin-password").value;
  const voteId = elements.adminVoteId.value.trim();
  const button = elements.adminForm.querySelector("button");
  setButtonBusy(button, true, "관리자 삭제");
  try {
    await callVoteApi({ action: "delete-admin", pollSlug, voteId, password });
    $("#admin-password").value = "";
    elements.adminVoteId.value = "";
    setMessage(elements.adminMessage, "관리자 권한으로 투표를 삭제했습니다.", "success");
  } catch (error) {
    setMessage(elements.adminMessage, error.message, "error");
  } finally {
    setButtonBusy(button, false, "관리자 삭제");
  }
});

async function init() {
  setupTabs();
  elements.adminConsole.hidden = !adminMode;
  if (!configured) {
    elements.setupNote.hidden = false;
    elements.status.textContent = "연결 설정 필요";
    return;
  }
  state.client = createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    await loadInitialData();
    startRealtime();
  } catch (error) {
    elements.status.textContent = "데이터 연결 실패";
    elements.setupNote.hidden = false;
    elements.setupNote.textContent = `연결 오류: ${error.message}`;
  }
}

init();
