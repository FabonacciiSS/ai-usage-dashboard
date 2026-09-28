import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
TOKEN_URL = "https://auth.openai.com/oauth/token"
USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

access = os.environ.get("OPENAI_ACCESS_TOKEN", "").strip()
refresh = os.environ.get("OPENAI_REFRESH_TOKEN", "").strip()
expires_ms = int(os.environ.get("OPENAI_TOKEN_EXPIRES", "0") or "0")
now_ms = int(time.time() * 1000)

refreshed = False
new_refresh = None
new_expires = None


def refresh_token():
    global access, refreshed, new_refresh, new_expires
    data = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "redirect_uri": "https://openai.com/app",
            "refresh_token": refresh,
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8", "replace"))
    access = body.get("access_token", "")
    new_refresh = body.get("refresh_token")
    expires_in = int(body.get("expires_in", 0) or 0)
    new_expires = now_ms + expires_in * 1000 if expires_in else None
    refreshed = True


if not access:
    print(json.dumps({"ok": False, "error": "OPENAI_ACCESS_TOKEN not set"}))
    sys.exit(0)

# Refresh from the Python network stack: Electron's requests get rejected by
# OpenAI's region check, this one does not.
if refresh and expires_ms and expires_ms - now_ms < 60_000:
    try:
        refresh_token()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        print(json.dumps({"ok": False, "status": e.code, "error": detail, "refreshFailed": True}))
        sys.exit(0)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e), "refreshFailed": True}))
        sys.exit(0)

headers = {
    "Authorization": "Bearer " + access,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "oai-device-id": str(uuid.uuid4()),
    "oai-app-name": "chatgpt-web",
    "oai-language": "en-US",
    "Origin": "https://chatgpt.com",
    "Referer": "https://chatgpt.com/",
    "User-Agent": UA,
}

last_error = None
for attempt in range(2):
    try:
        req = urllib.request.Request(USAGE_URL, headers=headers)
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        print(
            json.dumps(
                {
                    "ok": True,
                    "status": resp.status,
                    "data": data,
                    "refreshed": refreshed,
                    "access": access if refreshed else None,
                    "refresh": new_refresh,
                    "expires": new_expires,
                }
            )
        )
        sys.exit(0)
    except urllib.error.HTTPError as e:
        last_error = {"status": e.code, "error": e.read().decode("utf-8", "replace")[:500]}
    except Exception as e:  # noqa: BLE001
        last_error = {"error": str(e)}
    if attempt == 0:
        time.sleep(1.0)

print(json.dumps({"ok": False, "refreshed": refreshed, **(last_error or {"error": "Unknown error"})}))
