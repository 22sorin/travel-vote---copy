const form = document.querySelector("#hash-form");
const passwordInput = document.querySelector("#master-password");
const confirmInput = document.querySelector("#master-password-confirm");
const generateButton = document.querySelector("#generate-button");
const message = document.querySelector("#message");
const resultSection = document.querySelector("#result-section");
const hashOutput = document.querySelector("#hash-output");
const copyButton = document.querySelector("#copy-button");

function setMessage(text = "", type = "") {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function copyHash() {
  hashOutput.select();
  try {
    document.execCommand("copy");
    setMessage("해시를 복사했습니다. Supabase Secrets에 붙여넣으세요.", "success");
  } catch {
    setMessage("해시를 선택했어요. 직접 복사해 주세요.", "error");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const password = passwordInput.value;
  const confirmation = confirmInput.value;
  const byteLength = new TextEncoder().encode(password).length;
  if (password !== confirmation) return setMessage("비밀번호 확인이 일치하지 않습니다.", "error");
  if (byteLength < 4 || byteLength > 72) return setMessage("비밀번호는 4~72바이트로 입력해 주세요.", "error");
  if (!window.dcodeIO?.bcrypt) return setMessage("bcrypt 도구를 불러오지 못했습니다. 페이지를 다시 열어 주세요.", "error");

  generateButton.disabled = true;
  generateButton.textContent = "해시 생성 중…";
  setMessage("비밀번호를 해시로 변환하고 있습니다.");
  window.dcodeIO.bcrypt.hash(password, 12, (error, hash) => {
    passwordInput.value = "";
    confirmInput.value = "";
    generateButton.disabled = false;
    generateButton.textContent = "bcrypt 해시 만들기";
    if (error) return setMessage("해시를 만들지 못했습니다. 페이지를 다시 열고 시도해 주세요.", "error");
    hashOutput.value = hash;
    resultSection.hidden = false;
    setMessage("해시가 생성됐습니다. 아래 값을 복사해 Supabase Secrets에 넣으세요.", "success");
  });
});

copyButton.addEventListener("click", copyHash);
