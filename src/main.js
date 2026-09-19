const { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, session } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");

// Keep Electron's OS encryption key stable even when a diagnostic entry point is used.
app.setPath("userData", path.join(app.getPath("appData"), "codex-usage-desktop-dashboard"));

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";

const CAR360_BASE_URL = "https://ai.car360.info";
const CAR360_USAGE_URL = `${CAR360_BASE_URL}/v1/usage`;
const OPENCODE_GO_BASE_URL = "https://opencode.ai";

function readDotEnv() {
  const result = {};
  const candidates = [
    process.env.USAGE_DASHBOARD_ENV_FILE,
    path.join(os.homedir(), ".env"),
    path.join(__dirname, "..", ".env")
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator < 1) continue;
        result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
      }
      return result;
    } catch {
      /* try next candidate */
    }
  }
  return result;
}

function sessionStorePath() {
  return path.join(app.getPath("appData"), "codex-usage-desktop-dashboard", "opencode-go-sessions.json");
}

function readSessionStore() {
  try {
    return JSON.parse(fs.readFileSync(sessionStorePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSessionStore(store) {
  fs.mkdirSync(path.dirname(sessionStorePath()), { recursive: true });
  fs.writeFileSync(sessionStorePath(), JSON.stringify(store, null, 2), "utf8");
}

function importOpenCodeGoSessionFromEnvironment() {
  const label = process.env.OPENCODE_GO_IMPORT_LABEL;
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID;
  const cookieFile = process.env.OPENCODE_GO_COOKIE_FILE;
  if (!label || !workspaceId || !cookieFile) return;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows credential encryption is unavailable");
  }
  const cookie = fs.readFileSync(cookieFile, "utf8").trim();
  const store = readSessionStore();
  store[label] = {
    workspaceId,
    auth: safeStorage.encryptString(cookie).toString("base64"),
    importedAt: new Date().toISOString()
  };
  writeSessionStore(store);
  fs.rmSync(cookieFile, { force: true });
}

function parseGoStatus(data) {
  const meters = data?.access?.meters || {};
  const now = Date.now();
  const pct = (meter) => {
    const limit = Number(meter?.limitMicroCents) || 0;
    const usage = Number(meter?.usedMicroCents) || 0;
    return { usagePercent: limit > 0 ? (usage / limit) * 100 : 0, usage, limit };
  };
  const resetIn = (iso) => {
    if (!iso) return null;
    const diff = Math.round((new Date(iso).getTime() - now) / 1000);
    return diff > 0 ? diff : 0;
  };
  const rolling = pct(meters.fiveHour);
  const weekly = pct(meters.week);
  const monthly = pct(meters.month);
  return {
    rolling: { ...rolling, resetInSec: resetIn(meters.fiveHour?.resetsAt) },
    weekly: { ...weekly, resetInSec: resetIn(meters.week?.resetsAt) },
    monthly: {
      ...monthly,
      resetInSec: resetIn(meters.month?.resetsAt) ?? resetIn(data?.access?.endsAt)
    }
  };
}

function openCodeGoSession(label) {
  return session.fromPartition(`persist:opencode-go-${label}`);
}

async function fetchGoStatus(ses, workspaceId) {
  const response = await ses.fetch("https://opencode.ai/console/api/go/status", {
    headers: { Accept: "application/json", "x-org-id": workspaceId }
  });
  if (response.status === 401 || response.status === 403) return { needsLogin: true };
  if (!response.ok) return { error: `Gateway usage request failed (${response.status})` };
  const data = await response.json().catch(() => null);
  if (!data?.access?.meters) return { error: "Unexpected Go status response" };
  return { data };
}

async function getOpenCodeGoUsage(label) {
  const record = readSessionStore()[label];
  if (!record?.workspaceId) {
    return { ok: false, needsLogin: true, error: "Account session not imported" };
  }
  const ses = openCodeGoSession(label);

  // Restore the login into this session partition if it was cleared.
  const existing = await ses.cookies.get({ name: "auth" });
  if (!existing.length && record.auth) {
    try {
      const value = safeStorage.decryptString(Buffer.from(record.auth, "base64"));
      await ses.cookies.set({ url: "https://opencode.ai/", name: "auth", value, httpOnly: true });
    } catch {
      /* ignore, request will report login needed */
    }
  }

  const result = await fetchGoStatus(ses, record.workspaceId);
  if (result.needsLogin) {
    return { ok: false, needsLogin: true, error: "OpenCode Go session expired" };
  }
  if (result.error) return { ok: false, needsLogin: true, error: result.error };

  const sessionInfo = await ses
    .fetch("https://opencode.ai/console/auth/session", { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    workspaceId: record.workspaceId,
    email: sessionInfo?.user?.email || null,
    ...parseGoStatus(result.data)
  };
}

async function verifyOpenCodeSession(ses, workspaceId) {
  try {
    const orgsResponse = await ses.fetch("https://opencode.ai/console/api/orgs", {
      headers: { Accept: "application/json" }
    });
    if (orgsResponse.ok) {
      const list = await orgsResponse.json().catch(() => []);
      const orgs = Array.isArray(list) ? list : list?.orgs || [];
      const match = orgs.find((org) => org?.id === workspaceId) || orgs[0];
      if (match?.id) workspaceId = match.id;
    }
  } catch {
    /* fall back to the known workspace id */
  }
  const result = await fetchGoStatus(ses, workspaceId);
  if (!result.data) return null;
  const sessionInfo = await ses
    .fetch("https://opencode.ai/console/auth/session", { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return { workspaceId, usage: parseGoStatus(result.data), email: sessionInfo?.user?.email || null };
}

// Opens an in-app login window. Each account uses its own persistent session
// partition so both can stay signed in at the same time, unlike a single browser.
function reconnectOpenCodeGo(label) {
  return new Promise((resolve) => {
    const partition = `persist:opencode-go-${label}`;
    const ses = session.fromPartition(partition);
    const store = readSessionStore();
    const knownWorkspace = store[label]?.workspaceId || null;
    const startUrl = knownWorkspace
      ? `${OPENCODE_GO_BASE_URL}/console/${knownWorkspace}/go`
      : `${OPENCODE_GO_BASE_URL}/console`;

    const win = new BrowserWindow({
      width: 640,
      height: 780,
      title: `Sign in to OpenCode Go · ${label}`,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111418" : "#f6f7f9",
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false }
    });
    win.loadURL(startUrl);
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });

    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      resolve(result);
    };

    async function attempt() {
      if (settled) return;
      try {
        const cookies = await ses.cookies.get({ name: "auth" });
        const auth = cookies.find((cookie) => (cookie.domain || "").endsWith("opencode.ai"));
        if (!auth) return;

        const verified = await verifyOpenCodeSession(ses, knownWorkspace);
        if (!verified) return;
        if (!safeStorage.isEncryptionAvailable()) {
          finish({ ok: false, error: "System credential encryption is unavailable" });
          return;
        }

        const next = readSessionStore();
        next[label] = {
          workspaceId: verified.workspaceId,
          auth: safeStorage.encryptString(auth.value).toString("base64"),
          importedAt: new Date().toISOString()
        };
        writeSessionStore(next);
        finish({ ok: true, workspaceId: verified.workspaceId, email: verified.email });
        if (!win.isDestroyed()) win.close();
      } catch {
        /* keep waiting until the user finishes signing in */
      }
    }

    timer = setInterval(attempt, 2000);
    win.webContents.on("did-navigate", () => attempt());
    win.webContents.on("did-navigate-in-page", () => attempt());
    win.webContents.on("did-finish-load", () => attempt());

    win.on("closed", () => finish({ ok: false, canceled: true }));
  });
}

async function getDeepSeekBalance() {
  const apiKey = process.env.DEEPSEEK_API_KEY || readDotEnv().DEEPSEEK_API_KEY;
  if (!apiKey) return { ok: false, error: "DeepSeek API key not configured" };
  const response = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: body.error?.message || `DeepSeek balance failed (${response.status})` };
  return { ok: true, generatedAt: new Date().toISOString(), data: body };
}

function findCar360ApiKey() {
  if (process.env.CAR360_API_KEY) return process.env.CAR360_API_KEY;
  for (const p of [
    path.join(os.homedir(), ".codex", "auth.json"),
    path.join(os.homedir(), ".codex", "config.toml")
  ]) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const m = raw.match(/OPENAI_API_KEY\s*[:=]\s*"?((?:sk-)?[A-Za-z0-9]{20,})"?/);
      if (m && m[1]) return m[1];
      if (p.endsWith(".json")) {
        const parsed = JSON.parse(raw);
        if (parsed.OPENAI_API_KEY) return parsed.OPENAI_API_KEY;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

let lastCar360Snapshot = null;

async function getCar360UsageSnapshot({ force }) {
  const now = Date.now();
  if (!force && lastCar360Snapshot && now - lastCar360Snapshot.generatedAtMs < SNAPSHOT_TTL_MS) {
    return lastCar360Snapshot.data;
  }

  const apiKey = findCar360ApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: "Gateway API key not found. Set CAR360_API_KEY env var or configure it in ~/.codex/auth.json."
    };
  }

  const response = await fetch(`${CAR360_USAGE_URL}?days=1`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body.detail || body.error?.message || body.message || `Gateway usage request failed (${response.status})`,
      body
    };
  }

  const localNow = new Date();
  const today = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}`;
  const latestUsageDate = body.daily_usage?.at?.(-1)?.date || null;
  const dailySpend = Number(body.subscription?.daily_usage_usd) || 0;
  // The gateway can briefly serve the previous day's aggregate after midnight.
  // Reject it instead of persisting yesterday's spend under today's fetch time.
  if (latestUsageDate && latestUsageDate !== today && dailySpend > 0) {
    return {
      ok: false,
      stale: true,
      dataDate: latestUsageDate,
      error: `Gateway has not published ${today} usage yet`
    };
  }

  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    generatedAtMs: now,
    dataDate: latestUsageDate || today,
    data: body
  };
  lastCar360Snapshot = { generatedAtMs: now, data };
  return data;
}

function findOpenCodeAuthFile() {
  const candidates = [];
  if (process.env.OPENCODE_AUTH_FILE) candidates.push(process.env.OPENCODE_AUTH_FILE);
  candidates.push(
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(os.homedir(), "AppData", "Roaming", "opencode", "auth.json")
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function refreshOpenAIToken(refreshToken) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: "https://openai.com/app",
    refresh_token: refreshToken
  });
  const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      error: body.error?.message || body.error_description || `Token refresh failed (${response.status})`
    };
  }
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresInSec: body.expires_in
  };
}

let lastCodexSnapshot = null;
const SNAPSHOT_TTL_MS = 60 * 1000;

async function getCodexUsageSnapshot({ force }) {
  const now = Date.now();
  if (!force && lastCodexSnapshot && now - lastCodexSnapshot.generatedAtMs < SNAPSHOT_TTL_MS) {
    return lastCodexSnapshot.data;
  }

  const authFile = findOpenCodeAuthFile();
  if (!authFile) {
    return {
      ok: false,
      error:
        "OpenCode auth.json not found. Install/authenticate opencode (opencode auth login) or run with OPENCODE_AUTH_FILE=<path>."
    };
  }

  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authFile, "utf8")).openai;
  } catch (error) {
    return { ok: false, error: `Failed to read ${authFile}: ${error.message}` };
  }

  if (!auth || !auth.access) {
    return { ok: false, error: "No OpenAI OAuth credentials found in opencode auth.json." };
  }

  let accessToken = auth.access;
  let refreshed = false;

  const expiresMs = Number(auth.expires || 0);
  if (expiresMs - now < 60 * 1000 && auth.refresh) {
    const refreshedToken = await refreshOpenAIToken(auth.refresh);
    if (refreshedToken.ok) {
      accessToken = refreshedToken.accessToken;
      refreshed = true;
      try {
        const parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
        parsed.openai = {
          ...parsed.openai,
          access: refreshedToken.accessToken,
          refresh: refreshedToken.refreshToken || refreshedToken.accessToken,
          expires: now + refreshedToken.expiresInSec * 1000
        };
        fs.writeFileSync(authFile, JSON.stringify(parsed, null, 2), "utf8");
      } catch (error) {
        return {
          ok: false,
          error: `Token refreshed but failed to persist: ${error.message}`
        };
      }
    } else {
      return {
        ok: false,
        error: `OpenAI OAuth refresh failed: ${refreshedToken.error}. Run 'opencode auth login' to re-authenticate.`
      };
    }
  }

  // chatgpt.com rejects Electron's TLS fingerprint (403). Route the request through
  // a local Python helper, whose network stack passes the reverse-proxy check.
  const helper = path.join(__dirname, "..", "scripts", "codex_pyfetch.py");
  const raw = await new Promise((resolve) => {
    const child = execFile(
      process.env.PYTHON || "python",
      [helper],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, OPENAI_ACCESS_TOKEN: accessToken }
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(JSON.stringify({ ok: false, error: `Python helper failed: ${error.message}` }));
          return;
        }
        try {
          resolve(stdout);
        } catch {
          resolve(JSON.stringify({ ok: false, error: "Python helper returned invalid output" }));
        }
      }
    );
  });
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Codex fetch helper returned invalid JSON" };
  }

  if (!payload.ok) {
    return {
      ok: false,
      status: payload.status,
      error: payload.error || "Codex usage request failed"
    };
  }

  const body = payload.data;
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    generatedAtMs: now,
    refreshed,
    data: body
  };
  lastCodexSnapshot = { generatedAtMs: now, data };
  return data;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: "AI Usage Dashboard",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111418" : "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

app.on("nativeTheme", () => {
  const dark = nativeTheme.shouldUseDarkColors;
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(dark ? "#111418" : "#f6f7f9");
    try {
      win.webContents.send("theme:changed", dark);
    } catch {
      /* window not ready yet */
    }
  }
});

ipcMain.handle("theme:set", (event, mode) => {
  if (["system", "light", "dark"].includes(mode)) nativeTheme.themeSource = mode;
  return { mode: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors };
});
ipcMain.handle("theme:get", () => ({
  mode: nativeTheme.themeSource,
  dark: nativeTheme.shouldUseDarkColors
}));

app.whenReady().then(() => {
  importOpenCodeGoSessionFromEnvironment();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

async function openaiRequest(endpoint, params) {
  const apiKey = process.env.OPENAI_ADMIN_KEY;
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      error: "Missing OPENAI_ADMIN_KEY. Usage and cost endpoints require an admin key."
    };
  }

  const url = new URL(`https://api.openai.com/v1/organization/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
    } else if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body.error?.message || response.statusText || "OpenAI request failed"
    };
  }

  return { ok: true, status: response.status, data: body };
}

ipcMain.handle("openai:getUsageSnapshot", async () => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);

  const baseParams = {
    start_time: toUnixSeconds(start),
    end_time: toUnixSeconds(end),
    bucket_width: "1d"
  };

  const [usage, costs] = await Promise.all([
    openaiRequest("usage/completions", { ...baseParams, group_by: ["model"], limit: 31 }),
    openaiRequest("costs", { ...baseParams, limit: 31 })
  ]);

  return {
    generatedAt: new Date().toISOString(),
    usage,
    costs
  };
});

ipcMain.handle("codex:getUsageSnapshot", async (event, payload = {}) => {
  return getCodexUsageSnapshot({ force: Boolean(payload.force) });
});

ipcMain.handle("car360:getUsageSnapshot", async (event, payload = {}) => {
  return getCar360UsageSnapshot({ force: Boolean(payload.force) });
});

ipcMain.handle("deepseek:getBalance", async () => getDeepSeekBalance());

ipcMain.handle("opencode-go:getUsage", async (event, payload = {}) => {
  return getOpenCodeGoUsage(payload.label);
});

ipcMain.handle("opencode-go:reconnect", async (event, payload = {}) => {
  const label = payload.label;
  if (!["github", "gmail"].includes(label)) {
    return { ok: false, error: "Unknown account label" };
  }
  return reconnectOpenCodeGo(label);
});
