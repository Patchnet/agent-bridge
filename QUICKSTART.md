# Quick Start — Deploy Patchnet Agent Bridge

Deploy the Patchnet Agent Bridge on a new machine from GitHub.

---

## Prerequisites

- **Node.js** (current LTS)
- **OpenClaw installed and registered** — device identity must exist at `%USERPROFILE%\.openclaw\identity\device.json`
- **Azure app registration created** — see [README.md](README.md) for full setup (Option A: manifest import, Option B: manual)

---

## Clone & Install

```powershell
git clone https://github.com/Patchnet/agent-bridge.git
cd agent-bridge
npm install
powershell -ExecutionPolicy Bypass -File scripts\setup-bridge.ps1
```

---

## What the Setup Script Does

The script walks through 9 steps:

1. Verifies Node.js is installed
2. Checks/installs npm packages
3. Prompts for credentials (have these ready):

| Credential | Where to Find It |
|---|---|
| `TENANT_ID` | Azure Portal → Microsoft Entra ID → Overview |
| `CLIENT_ID` | Azure Portal → App registrations → your app → Overview |
| `CLIENT_SECRET` | App registration → Certificates & secrets → client secret **Value** (not Secret ID) |
| `BOT_USER_ID` | Entra ID → Users → agent account → **Object ID** (NOT the app registration ID) |
| `OPENCLAW_URL` | Press Enter for default `ws://127.0.0.1:18789` |
| `OPENCLAW_TOKEN` | From `openclaw.json` → `gateway.auth.token` |
| `OPENCLAW_AGENT_ID` | Press Enter for default `main` |
| `ALLOWED_USERS` | Comma-separated UPNs or Entra object IDs, or blank to allow all |
| `EMAIL_MODE` | `off`, `read`, or `full` — controls email tool availability |
| `BOT_EMAIL` | Agent account email address (needed if EMAIL_MODE is read or full) |
| `EMAIL_WHITELIST` | Comma-separated addresses/domains for outbound email (e.g., `*@yourdomain.com`) |
| `CHANNEL_MANAGER` | UPN of the user who manages channel modes via DM (e.g., `admin@yourdomain.com`) |

4. Opens browser for agent account login
5. Captures the OAuth callback on `localhost:3000`
6. Exchanges auth code for refresh token
7. Writes a complete `.env` file

> **Log in as the agent account** (e.g., `teams-bridge@yourdomain.com`) — not your personal account.

---

## Register the Skill with OpenClaw

After setup, register the bridge's skill directory so the OpenClaw agent knows about the bridge tools:

1. Open `openclaw.json` (typically at `%USERPROFILE%\.openclaw\openclaw.json` on Windows or `~/.openclaw/openclaw.json` on macOS/Linux)
2. Add the skill directory to `skills.load.extraDirs`:

```json
{
  "skills": {
    "load": {
      "extraDirs": [
        "C:\\Dev\\agent-bridge\\skill"
      ]
    }
  }
}
```

3. Restart the OpenClaw gateway to pick up the new skill.

When you update the bridge via `git pull`, the skill updates automatically — no manual copy needed.

---

## Start the Bridge

Using the CLI:
```powershell
powershell -ExecutionPolicy Bypass -File bridge.ps1
```
Then type `start` at the prompt.

Or directly:
```powershell
node index.js
```

You should see the Patchnet ASCII logo followed by:

```
  Log level     : full
  Bot user ID   : <guid>
  Openclaw URL  : ws://127.0.0.1:18789
  DM poll       : 5000 ms
  Channel poll  : 10000 ms
  Channel mgr   : admin@yourdomain.com
  Email mode    : full
  Email poll    : 15000 ms
  Bridge tools  : registered (...)

[openclaw] Authenticated and ready
[bridge] Discovered N oneOnOne chat(s) — seeding cursors...
```

Send a DM to the agent account from Teams — you should see the message logged and a reply come back within a few seconds.

---

## Multi-Agent Deployment (second agent on same tenant)

If you're deploying a second agent account on the same tenant:

1. **New app registration** — create `agent2-bridge` in Azure Portal (same permissions, same manifest)
2. **New client secret** — on the new app registration
3. **Grant admin consent** — on the new app registration
4. **Exclude from MFA** — add the new agent account to Conditional Access exclusion
5. **New OpenClaw device** — register a device identity on the new machine
6. **Run the setup script** — it prompts for the new CLIENT_ID, CLIENT_SECRET, BOT_USER_ID

The `TENANT_ID` stays the same. Everything else is unique per deployment.

---

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| `AADSTS65001` or `AADSTS50076` on token refresh | Agent account hitting MFA Conditional Access policy | Exclude agent account from MFA policy in Entra ID → Security → Conditional Access |
| Bridge processes its own replies in a loop | Wrong `BOT_USER_ID` — used app registration Object ID instead of user Object ID | Entra ID → Users → agent account → Object ID |
| Login opens your personal account | Browser cached session | Script launches incognito/InPrivate — verify you're logging in as the **agent account** |
| File downloads return null | Missing `Sites.ReadWrite.All` consent | Re-grant admin consent on the app registration |
| `ECONNREFUSED` on startup | OpenClaw gateway not running | Start the OpenClaw gateway, verify `OPENCLAW_URL` in `.env` |
| `Authenticated and ready` never appears | Wrong `OPENCLAW_TOKEN` or device identity mismatch | Check token matches `openclaw.json` → `gateway.auth.token`; verify `device.json` exists |
| Email tools not registered | `EMAIL_MODE` missing or set to `off` in `.env` | Set `EMAIL_MODE=full` and restart |
| Calendar/tasks/people tools return 403 | Agent account hasn't consented to new scopes | Re-run setup script to re-auth with updated permissions |
| `node_modules not found` on start | Dependencies not installed | Run `npm install` in the bridge directory |

---

For full setup details (app registration, permissions, architecture), see [README.md](README.md).
