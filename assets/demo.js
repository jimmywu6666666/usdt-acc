const button = document.querySelector("#claimBtn");
const result = document.querySelector("#result");
const error = document.querySelector("#error");
const CLAIM_TOKEN_KEY = "usdt-ledger-demo-claim-token";
const claimToken = (() => {
  const existing = localStorage.getItem(CLAIM_TOKEN_KEY);
  if (existing) return existing;
  const next = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(CLAIM_TOKEN_KEY, next);
  return next;
})();
const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[char]));
let currentClaim = null;

button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "正在分配...";
  error.classList.remove("show");
  result.classList.remove("show");
  try {
    const response = await fetch("/api/demo/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimToken }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "领取失败");
    const claim = payload.claim;
    currentClaim = claim;
    result.innerHTML = `
      <div class="row"><span>演示系统</span><strong>${escapeHtml(claim.tenantName)}</strong></div>
      <div class="row"><span>登录账号</span><strong>${escapeHtml(claim.loginName)}</strong></div>
      <div class="row"><span>登录密码</span><strong>${escapeHtml(claim.password)}</strong></div>
      <button class="login-link" type="button" id="demoLoginBtn">进入演示系统</button>
      <p class="demo-login-hint">演示账号无需动态验证码。</p>
    `;
    result.classList.add("show");
    document.querySelector("#demoLoginBtn").addEventListener("click", loginDemoAccount);
    button.textContent = "已领取";
  } catch (err) {
    error.textContent = err.message || "领取失败";
    error.classList.add("show");
    button.disabled = false;
    button.textContent = "重新领取";
  }
});

async function loginDemoAccount() {
  if (!currentClaim) return;
  const loginButton = document.querySelector("#demoLoginBtn");
  loginButton.disabled = true;
  loginButton.textContent = "正在进入...";
  error.classList.remove("show");
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginName: currentClaim.loginName,
        password: currentClaim.password,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "登录失败");
    localStorage.setItem("usdt-ledger-session:v1", JSON.stringify({
      token: payload.token,
      userId: payload.user?.id,
    }));
    window.location.href = "/";
  } catch (err) {
    error.textContent = err.message || "登录失败";
    error.classList.add("show");
    loginButton.disabled = false;
    loginButton.textContent = "进入演示系统";
  }
}
