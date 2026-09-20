const STORAGE_KEY = "ai-usage-dashboard-v2";

const els = {
  codexH5Used: document.querySelector("#codexH5Used"),
  codexH5Progress: document.querySelector("#codexH5Progress"),
  codexH5Remaining: document.querySelector("#codexH5Remaining"),
  codexWeekUsed: document.querySelector("#codexWeekUsed"),
  codexWeekProgress: document.querySelector("#codexWeekProgress"),
  codexWeekRemaining: document.querySelector("#codexWeekRemaining"),
  car360Used: document.querySelector("#car360Used"),
  car360Progress: document.querySelector("#car360Progress"),
  car360Remaining: document.querySelector("#car360Remaining"),
  deepseekBalance: document.querySelector("#deepseekBalance"),
  deepseekStatus: document.querySelector("#deepseekStatus"),
  zenBalance: document.querySelector("#zenBalance"),
  zenStatus: document.querySelector("#zenStatus"),
  goGithubAccount: document.querySelector("#goGithubAccount"),
  goGithubWindows: document.querySelector("#goGithubWindows"),
  goGithubEmpty: document.querySelector("#goGithubEmpty"),
  goGmailAccount: document.querySelector("#goGmailAccount"),
  goGmailWindows: document.querySelector("#goGmailWindows"),
  goGmailEmpty: document.querySelector("#goGmailEmpty"),
  goGithubReconnect: document.querySelector("#goGithubReconnect"),
  goGmailReconnect: document.querySelector("#goGmailReconnect"),
  codexSourceStatus: document.querySelector("#codexSourceStatus"),
  car360SourceStatus: document.querySelector("#car360SourceStatus"),
  deepseekSourceStatus: document.querySelector("#deepseekSourceStatus"),
  zenSourceStatus: document.querySelector("#zenSourceStatus"),
  goGithubSourceStatus: document.querySelector("#goGithubSourceStatus"),
  goGmailSourceStatus: document.querySelector("#goGmailSourceStatus"),
  updatedAt: document.querySelector("#updatedAt"),
  syncAllButton: document.querySelector("#syncAllButton"),
  themeToggleButton: document.querySelector("#themeToggleButton")
};

let state = loadState();

function isSameLocalDay(left, right = new Date()) {
  const date = left ? new Date(left) : null;
  if (!date || Number.isNaN(date.getTime())) return false;
  return (
    date.getFullYear() === right.getFullYear() &&
    date.getMonth() === right.getMonth() &&
    date.getDate() === right.getDate()
  );
}

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function loadState() {
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    if (!cached.car360?.dataDate || cached.car360.dataDate !== localDayKey()) {
      delete cached.car360;
    }
    return cached;
  } catch {
    return {};
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatNumber(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value || 0);
}

function formatCompactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return formatNumber(n);
}

function formatCompactCurrency(value, currency) {
  const symbol = { USD: "$", CNY: "¥" }[currency] || "";
  return `${symbol}${Number(value).toFixed(2)}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function tone(percent) {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warn";
  return "good";
}

function setProgress(element, percent) {
  const value = clamp(Number(percent) || 0, 0, 100);
  element.style.width = `${value}%`;
  element.dataset.tone = tone(value);
}

function renderCodex() {
  const snapshot = state.codex;
  const primary = snapshot?.ok ? snapshot.data?.rate_limit?.primary_window : null;
  const weekly = snapshot?.ok ? snapshot.data?.rate_limit?.secondary_window : null;
  if (!primary || !weekly) {
    els.codexH5Remaining.textContent = snapshot?.error || "Unavailable";
    els.codexWeekRemaining.textContent = snapshot?.error || "Unavailable";
    els.codexSourceStatus.textContent = "Unavailable";
    els.codexSourceStatus.className = "status-warn";
    return;
  }
  els.codexH5Used.textContent = `${primary.used_percent || 0}%`;
  els.codexH5Remaining.textContent = `Resets in ${formatDuration(primary.reset_after_seconds)}`;
  setProgress(els.codexH5Progress, primary.used_percent);
  els.codexWeekUsed.textContent = `${weekly.used_percent || 0}%`;
  els.codexWeekRemaining.textContent = `Resets in ${formatDuration(weekly.reset_after_seconds)}`;
  setProgress(els.codexWeekProgress, weekly.used_percent);
  els.codexSourceStatus.textContent = snapshot.syncError
    ? `Last sync failed · showing ${formatDateTime(snapshot.generatedAt)}`
    : `Synced ${formatDateTime(snapshot.generatedAt)}`;
  els.codexSourceStatus.className = snapshot.syncError ? "status-warn" : "status-good";
}

function renderCar360() {
  const snapshot = state.car360;
  const data = snapshot?.ok ? snapshot.data : null;
  if (!data) {
    els.car360Used.textContent = "--";
    setProgress(els.car360Progress, 0);
    els.car360Remaining.textContent = snapshot?.error || "Syncing current day…";
    els.car360SourceStatus.textContent = "Unavailable";
    els.car360SourceStatus.className = "status-warn";
    return;
  }
  const limit = Number(data.subscription?.daily_limit_usd) || 100;
  const used = Number(data.subscription?.daily_usage_usd) || 0;
  const percent = limit > 0 ? (used / limit) * 100 : 0;
  els.car360Used.innerHTML = `<span class="nowrap">${formatCompactCurrency(used, "USD")} <span class="divider">/</span> ${formatCompactCurrency(limit, "USD")}</span>`;
  els.car360Remaining.textContent = `${formatCompactCurrency(data.remaining, "USD")} left · ${formatNumber(data.usage?.today?.requests)} requests`;
  setProgress(els.car360Progress, percent);
  els.car360SourceStatus.textContent = snapshot.syncError
    ? `Last sync failed · showing ${formatDateTime(snapshot.generatedAt)}`
    : `Synced ${formatDateTime(snapshot.generatedAt)}`;
  els.car360SourceStatus.className = snapshot.syncError ? "status-warn" : "status-good";
}

function renderDeepSeek() {
  const snapshot = state.deepseek;
  const info = snapshot?.ok ? snapshot.data?.balance_infos?.[0] : null;
  if (!info) {
    els.deepseekBalance.textContent = "--";
    els.deepseekStatus.textContent = snapshot?.error || "Unavailable";
    els.deepseekSourceStatus.textContent = "Unavailable";
    els.deepseekSourceStatus.className = "status-warn";
    return;
  }
  const currency = info.currency === "CNY" ? "CNY" : info.currency || "USD";
  els.deepseekBalance.innerHTML = `<span class="nowrap">${formatCompactCurrency(info.total_balance, currency)}</span>`;
  els.deepseekStatus.textContent = snapshot.data.is_available ? "API available" : "API unavailable";
  els.deepseekSourceStatus.textContent = `Synced ${formatDateTime(snapshot.generatedAt)}`;
  els.deepseekSourceStatus.className = snapshot.data.is_available ? "status-good" : "status-danger";
}

function renderZen() {
  const snapshot = state.zen;
  if (!snapshot?.ok) {
    els.zenBalance.textContent = "--";
    els.zenStatus.textContent = snapshot?.needsLogin ? "Gmail login needed" : snapshot?.error || "Unavailable";
    els.zenSourceStatus.textContent = snapshot?.needsLogin ? "Login needed" : "Unavailable";
    els.zenSourceStatus.className = "status-warn";
    return;
  }
  els.zenBalance.innerHTML = `<span class="nowrap">${formatCompactCurrency(snapshot.balanceUsd, "USD")}</span>`;
  els.zenStatus.textContent = snapshot.mode === "pay-as-you-go" ? "Pay-as-you-go" : "Prepaid balance";
  els.zenSourceStatus.textContent = `Synced ${formatDateTime(snapshot.generatedAt)}`;
  els.zenSourceStatus.className = "status-good";
}

function renderGoWindow(entry, label) {
  const percent = Number(entry.usagePercent) || 0;
  const resetText =
    entry.resetInSec === null || entry.resetInSec === undefined
      ? "no active window"
      : `resets in ${formatDuration(entry.resetInSec)}`;
  const element = document.createElement("div");
  element.className = "usage-window";
  element.innerHTML = `
    <div class="row-top">
      <span class="row-title">${label}</span>
      <strong>${percent.toFixed(1)}%</strong>
    </div>
    <div class="progress"><span data-tone="${tone(percent)}" style="width:${clamp(percent, 0, 100)}%"></span></div>
    <div class="row-meta"><span class="amount">${formatCompactNumber(entry.usage)}</span> <span class="divider">/</span> <span class="amount">${formatCompactNumber(entry.limit)}</span> · ${resetText}</div>
  `;
  return element;
}

function renderGoAccount(label, snapshot, accountEl, windowsEl, emptyEl, statusEl) {
  windowsEl.innerHTML = "";
  if (!snapshot?.ok) {
    accountEl.textContent = "Not connected";
    accountEl.classList.remove("connected");
    emptyEl.textContent = snapshot?.error || "Session not imported";
    emptyEl.style.display = "grid";
    statusEl.textContent = snapshot?.needsLogin ? "Login needed" : "Unavailable";
    statusEl.className = "status-warn";
    return;
  }
  accountEl.textContent = label;
  accountEl.classList.add("connected");
  emptyEl.style.display = "none";
  windowsEl.append(
    renderGoWindow(snapshot.rolling, "5 hours"),
    renderGoWindow(snapshot.weekly, "Weekly"),
    renderGoWindow(snapshot.monthly, "Monthly")
  );
  statusEl.textContent = `Synced ${formatDateTime(snapshot.generatedAt)}`;
  statusEl.className = "status-good";
}

function render() {
  renderCodex();
  renderCar360();
  renderDeepSeek();
  renderZen();
  renderGoAccount("Github", state.goGithub, els.goGithubAccount, els.goGithubWindows, els.goGithubEmpty, els.goGithubSourceStatus);
  renderGoAccount("Gmail", state.goGmail, els.goGmailAccount, els.goGmailWindows, els.goGmailEmpty, els.goGmailSourceStatus);
  els.updatedAt.textContent = state.updatedAt ? `Updated ${formatDateTime(state.updatedAt)}` : "Waiting for sync";
}

async function syncAll() {
  if (!window.usageBridge) return;
  els.syncAllButton.disabled = true;
  els.syncAllButton.textContent = "Syncing...";
  try {
    const [codex, car360, deepseek, zen, goGithub, goGmail] = await Promise.all([
      window.usageBridge.getCodexUsageSnapshot({ force: true }),
      window.usageBridge.getCar360UsageSnapshot({ force: true }),
      window.usageBridge.getDeepSeekBalance(),
      window.usageBridge.getZenBalance(),
      window.usageBridge.getOpenCodeGoUsage({ label: "github" }),
      window.usageBridge.getOpenCodeGoUsage({ label: "gmail" })
    ]);
    const keepLastSuccess = (previous, next) => {
      if (next?.ok) return next;
      if (previous?.ok) {
        return {
          ...previous,
          syncError: next?.error || "Sync failed",
          lastAttemptAt: new Date().toISOString()
        };
      }
      return next;
    };
    const keepCurrentDayGateway = (previous, next) => {
      if (next?.ok) return next;
      if (previous?.ok && previous.dataDate === localDayKey()) {
        return {
          ...previous,
          syncError: next?.error || "Sync failed",
          lastAttemptAt: new Date().toISOString()
        };
      }
      return next;
    };

    state = {
      codex: keepLastSuccess(state.codex, codex),
      car360: keepCurrentDayGateway(state.car360, car360),
      deepseek: keepLastSuccess(state.deepseek, deepseek),
      zen: keepLastSuccess(state.zen, zen),
      goGithub,
      goGmail,
      updatedAt: new Date().toISOString()
    };
    saveState();
    render();
  } finally {
    els.syncAllButton.disabled = false;
    els.syncAllButton.textContent = "Sync all";
  }
}

els.syncAllButton.addEventListener("click", syncAll);

async function reconnectAccount(label, button) {
  if (!window.usageBridge?.reconnectOpenCodeGo) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Waiting for sign-in…";
  try {
    const result = await window.usageBridge.reconnectOpenCodeGo({ label });
    if (result?.ok) await syncAll();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

els.goGithubReconnect?.addEventListener("click", () => reconnectAccount("github", els.goGithubReconnect));
els.goGmailReconnect?.addEventListener("click", () => reconnectAccount("gmail", els.goGmailReconnect));

const THEME_CYCLE = ["system", "light", "dark"];
let themeMode = "system";

function applyThemeMode(mode, dark) {
  themeMode = mode;
  const label = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" }[mode] || "Theme";
  els.themeToggleButton.textContent = label;
  document.documentElement.dataset.theme =
    mode === "system" ? (dark ? "dark" : "light") : mode;
}

async function initTheme() {
  if (!window.usageBridge || !els.themeToggleButton) return;
  try {
    const theme = await window.usageBridge.getTheme();
    applyThemeMode(theme.mode, theme.dark);
  } catch {
    applyThemeMode("system", window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
}

els.themeToggleButton?.addEventListener("click", async () => {
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % THEME_CYCLE.length];
  try {
    const theme = await window.usageBridge.setTheme(next);
    applyThemeMode(theme.mode, theme.dark);
  } catch {
    applyThemeMode(next, window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
});

window.usageBridge?.onThemeChanged?.((dark) => {
  if (themeMode === "system") applyThemeMode("system", dark);
  else applyThemeMode(themeMode, dark);
});

render();
syncAll();
initTheme();
setInterval(syncAll, 5 * 60 * 1000);
