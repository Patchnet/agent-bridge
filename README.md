# Patchnet Agent Bridge

A custom Node.js bridge that connects Microsoft Teams and Email to the OpenClaw AI gateway — giving your agents the ability to communicate, schedule, manage tasks, and work with files across Microsoft 365.

This project was driven by frustration with how AI lands in business today. For both the teams deploying it and the people using it, most of the experience feels foreign. It sits parallel to the way work actually happens, not inside it.

OpenClaw opened a new possibility: AI working inside a computer, the way we work. Our goal is to show these tools can come into a business without forcing it to reinvent everything it already has.

This is by no means a production-ready project. Exercise caution. That said, having an agent embedded in Microsoft 365 that operates like a coworker really brings home the potential of AI.

\- Luis

---

> ## ⚠ EXPERIMENTAL — READ BEFORE DEPLOYING
>
> **This project is experimental and provided as-is, with no warranty or guarantee of fitness for any purpose.**
>
> This bridge is configured to act as a licensed Microsoft 365 user account — simulating a user in your tenant. Before deploying, you must fully understand the implications:
>
> - **Microsoft 365 licensing:** The agent account must hold a valid Microsoft 365 user license (e.g., M365 Business Basic or higher). Unlicensed accounts cannot use Teams DMs, set presence, or access files.
> - **Tenant permissions:** Admin consent is required for all delegated permissions. Granting these permissions gives the agent account the ability to read/send DMs, access files, and set presence on behalf of that user. Understand what you are granting before proceeding.
> - **Use a dedicated agent account — not a real user:** We strongly recommend the delegated account be a purpose-built, licensed Microsoft 365 account (e.g., `teams-bridge@yourdomain.com`) — not tied to any real user. This limits blast radius, makes permissions auditable, and ensures the account can be locked or rotated without impacting anyone's personal access.
> - **Restrict the account's permissions:** Apply Conditional Access policies and limit the dedicated account to only the services this bridge requires. If email features are not enabled (`EMAIL_MODE=off`), the account should not have access to email. Only grant `Mail.ReadWrite` and `Mail.Send` if you explicitly enable email integration.
> - **Control outbound communication:** This bridge connects to an external OpenClaw gateway. We strongly recommend restricting or monitoring outbound traffic from the host machine to outside your tenant — use firewall rules, network policies, or a proxy to ensure only known endpoints are reachable.
> - **Security responsibility:** Secure your `.env` file, refresh token, and device identity file. Anyone with access to these can impersonate the agent account and interact with your tenant.
> - **Compliance:** Ensure this deployment complies with your organization's acceptable use policies, data handling requirements, and any applicable regulations (GDPR, HIPAA, etc.).
>
> **Patchnet disclaims all liability for any damages, data loss, policy violations, security incidents, or compliance failures arising from the use or misuse of this software. Use at your own risk.**

---

## How It Works

```
Teams DM  → Graph API polling (5s)   → OpenClaw WebSocket → Agent → reply → Teams
Channels  → Graph API polling (10s)  → OpenClaw WebSocket → Agent → reply → Channel thread
Email     → Graph API polling (15s)  → OpenClaw WebSocket → Agent → reply → Email
```

The bridge acts as a governance layer between your OpenClaw agents and Microsoft 365:

- **Two-zone architecture** — agents have unrestricted access to their own workspace, but all interactions with shared tenant resources (calendar, email, tasks, files, people) go through discrete bridge tools that are validated, logged, and auditable
- **Per-chat async processing** — messages are queued per-chat (FIFO) so concurrent conversations don't block each other
- **Ack with edit-in-place** — if a reply takes more than 6 seconds, the agent sends an acknowledgment message and edits it with the final response when ready
- **Ref-counted presence** — agent shows as Busy while processing any message, Available when idle

## Features

### Communication
- Full markdown → HTML rendering (headings, bold, bullets, tables, clickable links, inline code)
- Teams presence (green dot when available, busy while processing)
- User allowlist — restrict DMs to authorized users only (UPN or Entra object ID)
- Auto-rejection message for unauthorized users
- Channel monitoring — three access modes (monitor/managed/open), manager-controlled via DM
- Channel @mention detection — agent responds only when @mentioned, replies in-thread
- Channel reactions — add/remove emoji reactions to channel messages
- Email integration — three-tier mode (off/read/full), inbox polling, auto-reply, whitelist-gated sending
- Email whitelist enforcement — every outbound recipient validated at code level, cannot be bypassed by agent
- Shared mailbox support — agent-managed mailbox list, auto-removal on 403, manager notification

### Bridge Tools
- **Calendar** — get events, find free time, check schedules, create/update/cancel meetings, shared calendar support
- **Tasks** — Microsoft To Do list/task CRUD
- **People** — org directory search, user lookup, mailbox settings
- **Email** — send, reply, forward with cc/bcc (whitelist-gated)
- **Files** — OneDrive/SharePoint browse, search, shared-with-me, download URLs. *Currently scoped to the agent's own OneDrive and items shared with it — group/channel-library file access is planned.*
- **Channels** — read messages, post, reply in-thread with @mentions, react, importance marking
- **Shared Mailboxes** — add/remove/list monitored shared mailboxes

### Infrastructure
- Persistent WebSocket connection with auto-reconnect (3s backoff)
- Refresh token auto-rotation (self-renewing, no manual re-auth needed within 90 days)
- Graph API resilience — auto-retry on 401, 429 (with Retry-After + jitter), and transient 5xx
- Team/channel metadata caching with 5-minute TTL
- Deduplicated token refresh — concurrent callers share a single in-flight promise
- Outbound file sending — agent can send files to Teams via `teams-file` JSON blocks (local upload or SharePoint URL)

---

## Setup

### Prerequisites

- Node.js (current LTS recommended)
- A dedicated Azure AD app registration for this deployment (see below)
- OpenClaw gateway running locally with a registered device identity
- A licensed Microsoft 365 user account for the agent (M365 Business Basic or higher) — this bridge acts as that user in your tenant and requires a valid user license to access Teams, presence, and files

### 1. Azure App Registration

Create a dedicated app registration in Azure AD for this deployment. Do not reuse an existing registration — each bridge deployment should have its own.

> **This bridge uses delegated permissions only.** Application permissions are not required. See below for details.

#### Option A: Import the Manifest (Recommended)

A pre-built manifest is included in the repo at `app-registration-manifest.json`. It contains all required delegated permissions with the correct GUIDs.

1. Go to [Azure Portal → Microsoft Entra ID → App registrations](https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps)
2. Click **+ New registration**
3. **Name:** `agent1-bridge` (one app registration per deployment — e.g., `agent2-bridge`, `agent3-bridge`)
4. **Supported account types:** Select **Accounts in this organizational directory only** (Single tenant)
5. **Redirect URI:** Select **Web** from the dropdown, enter `http://localhost:3000/callback`
6. Click **Register**
7. Go to the **Manifest** tab (left sidebar)
8. Replace the `requiredResourceAccess` section with the contents from `app-registration-manifest.json`
9. Click **Save**

After creation, copy these two values from the **Overview** page — you'll need them for `.env`:
- **Application (client) ID** → `CLIENT_ID`
- **Directory (tenant) ID** → `TENANT_ID`

Then skip to **Create a Client Secret** below.

#### Option B: Manual Setup

If you prefer to add permissions manually:

1. Follow the same registration steps as Option A (steps 1–6)
2. Go to **API permissions** (left sidebar)
3. Click **+ Add a permission** → **Microsoft Graph** → **Delegated permissions**
4. Search for and add each of the following:

> **All permissions require admin consent.** After adding permissions, click **"Grant admin consent for [your tenant]"** on the API permissions page. The bridge will not function without this step.

**Core (required):**

| Permission | Purpose |
|---|---|
| `Chat.ReadWrite` | Read and send Teams DMs |
| `ChannelMessage.Read.All` | Read channel messages |
| `ChannelMessage.Send` | Send and react to channel messages |
| `Files.ReadWrite` | Access agent's own files |
| `Files.ReadWrite.All` | Access all files the agent can access |
| `Sites.ReadWrite.All` | Access SharePoint sites and document libraries |
| `Team.ReadBasic.All` | Read team names and descriptions |
| `Channel.ReadBasic.All` | List channels in a team |
| `User.Read` | Sign in and read user profile |
| `User.ReadBasic.All` | Read basic profiles of all users |
| `Presence.Read.All` | Read presence information |
| `Presence.ReadWrite` | Set agent presence (Available/Busy) |
| `offline_access` | Keep refresh token alive |

**Calendar & scheduling:**

| Permission | Purpose |
|---|---|
| `Calendars.ReadWrite` | Read/write calendar events |
| `Calendars.ReadWrite.Shared` | Read/write shared and delegated calendars |
| `Schedule.ReadWrite.All` | Free/busy and schedule lookups |

**People & directory:**

| Permission | Purpose |
|---|---|
| `People.Read` | Relevance-ranked people search |
| `Contacts.ReadWrite` | Contact and directory access |
| `MailboxSettings.Read` | Read working hours and timezone |

**Tasks:**

| Permission | Purpose |
|---|---|
| `Tasks.ReadWrite` | Microsoft To Do list and task management |

**Email (optional — only add if EMAIL_MODE=read or full):**

| Permission | Purpose |
|---|---|
| `Mail.ReadWrite` | Read inbox, manage mailbox |
| `Mail.Send` | Send, reply, forward email |

> `User.Read` is usually added by default. Verify it's in the list.
>
> **Email permissions are optional.** Only add `Mail.ReadWrite` and `Mail.Send` if you plan to enable email features (`EMAIL_MODE=read` or `EMAIL_MODE=full`). After adding these permissions, you must re-run the setup script to get a new refresh token that includes the expanded scopes.

#### Create a Client Secret

1. In the app registration, go to **Certificates & secrets** (left sidebar)
2. Click **+ New client secret**
3. **Description:** `agent1-bridge` (match to the app registration name — e.g., `agent2-bridge`, `agent3-bridge` for additional deployments)
4. **Expires:** Choose an expiration (24 months max recommended)
5. Click **Add**
6. Copy the **Value** column immediately — it is only shown once. This is your `CLIENT_SECRET`.

> Do not copy the **Secret ID** — you need the **Value**.

#### Grant Admin Consent

1. Still on the **API permissions** page, click **Grant admin consent for [your tenant]**
2. Confirm when prompted
3. All permissions should now show a green checkmark under **Status**

If you are not a Global Administrator or Privileged Role Administrator, you'll need someone with that role to click this button.

#### Get the Agent Account's Object ID

1. Go to [Microsoft Entra ID → Users](https://portal.azure.com/#view/Microsoft_AAD_IAM/UsersManagementMenuBlade/~/AllUsers)
2. Search for your agent account (e.g., `teams-bridge@yourdomain.com`)
3. Click the user → copy the **Object ID** from the profile page

This is your `BOT_USER_ID` — the bridge uses it to filter out its own messages and prevent loops.

> **Important:** This is the **user account's** Object ID from Entra ID → Users, not the app registration's Object ID. Using the wrong ID will cause the bridge to process its own replies in a loop.

### 2. OpenClaw Device Identity

The bridge authenticates to OpenClaw using a registered device identity file created during OpenClaw onboarding. If you installed OpenClaw via the standard installer and ran `openclaw onboard`, the file is already in place — the bridge reads it from the default OpenClaw location and no extra configuration is needed.

The file contains `deviceId`, `privateKeyPem`, and `publicKeyPem`. It is unique to each deployment and must never be committed to the repo. See the [OpenClaw documentation](https://docs.openclaw.ai/) if you've customized the install location or need to re-register a device.

### 3. Install & Run

**Windows:**

```powershell
git clone https://github.com/Patchnet/agent-bridge.git
cd agent-bridge
npm install
```

**macOS / Linux:**

```bash
git clone https://github.com/Patchnet/agent-bridge.git
cd agent-bridge
npm install
chmod +x bridge.sh scripts/*.sh
```

> **macOS/Linux prerequisites:** Node.js (current LTS), Python 3 (for OAuth callback listener and JSON parsing in the CLI), and `curl`.

### 4. Run the Setup Script

The setup script handles credentials, the OAuth login flow, and writes your `.env` in one pass:

**Windows:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-bridge.ps1
```

**macOS / Linux:**

```bash
./scripts/setup-bridge.sh
```

The script will:
1. Verify Node.js and npm packages
2. Prompt for all required credentials:
   - `TENANT_ID` — from Azure Portal → App registrations → Overview
   - `CLIENT_ID` — from the same Overview page
   - `CLIENT_SECRET` — from Certificates & secrets → client secret **Value** (not Secret ID)
   - `BOT_USER_ID` — from Entra ID → Users → agent account → Object ID
   - `OPENCLAW_URL` — press **Enter** to accept the default (`ws://127.0.0.1:18789`)
   - `OPENCLAW_TOKEN` — from `openclaw.json` → `gateway.auth.token`
   - `OPENCLAW_AGENT_ID` — press **Enter** to accept the default (`main`)
   - `ALLOWED_USERS` — comma-separated UPNs or Entra object IDs, or blank to allow all
   - `EMAIL_MODE` — `off` (default), `read`, or `full` — press **Enter** to skip email
   - `BOT_EMAIL` — agent account email address *(only if EMAIL_MODE is read or full)*
   - `EMAIL_WHITELIST` — comma-separated whitelist for send operations *(only if EMAIL_MODE is full)*
   - `EMAIL_POLL_INTERVAL_MS` — inbox poll interval, default 15000 *(only if EMAIL_MODE is full)*
3. Open a browser pointed at Microsoft login — **log in as the agent account** (not your personal account)
4. Capture the OAuth callback and exchange the auth code for a refresh token
5. Write a complete `.env` file (including email config if enabled)

> **Why a browser login?** The bridge uses **delegated auth** — it acts as the agent user account, not as an app. This requires one interactive login to establish the initial refresh token. After that, `auth.js` auto-rotates it on every use. As long as the bridge runs at least once every 90 days, re-authentication is never needed.
>
> **Why a minimal scope set in the OAuth URL?** The setup script requests a minimal scope set (`Chat.ReadWrite`, `User.Read`, `Presence.ReadWrite`, `offline_access`) to keep the OAuth URL short and avoid truncation. The access token includes **all permissions consented on the app registration** regardless of what scopes are requested — this is standard Entra behavior for delegated tokens. If `EMAIL_MODE` is set to `read` or `full`, `auth.js` also requests `Mail.ReadWrite` (and `Mail.Send` for full mode) — these must already be consented on the app registration.

If you prefer to configure manually, copy `.env.example` to `.env` and fill in all values. The `REFRESH_TOKEN` field requires running the OAuth flow separately.

### 5. Run

**Windows (PowerShell):**

```powershell
.\bridge.ps1
```

**macOS / Linux (Bash):**

```bash
./bridge.sh
```

Both CLIs provide an interactive prompt with commands: `start`, `stop`, `restart`, `status`, `config`, `teams`, `set`, `setup`, `logs`, `help`, `exit`.

For development, you can also run directly:

```bash
node index.js
```

---

## Architecture

```
index.js          — main loop, DM + channel + email polling, message processing, presence
lib/
  auth.js         — OAuth2 token management, refresh token rotation
  graph.js        — Shared Microsoft Graph API request helper
  teams.js        — Graph API helpers (chats, channels, messages, markdown→HTML, presence, files)
  email.js        — Email integration (inbox polling, reply, send, whitelist, mailbox management)
  openclaw.js     — Persistent WebSocket client for OpenClaw gateway
  channels.js     — Channel mode management (monitor/managed/open), manager commands
  files.js        — Outbound file block parsing (teams-file JSON convention)
  tools.js        — Bridge tool registry, parser, and executor (bridge-tool code fences)
  calendar.js     — Calendar bridge tools (events, scheduling, free/busy)
  tasks.js        — Task bridge tools (Microsoft To Do)
  people.js       — People and directory bridge tools
  drive.js        — OneDrive/SharePoint file bridge tools
  mailboxes.js    — Shared mailbox management and polling
  logo.js         — ASCII art logo and startup banner
scripts/
  setup-bridge.ps1  — one-shot OAuth2 setup + .env generation (Windows)
  setup-bridge.sh   — one-shot OAuth2 setup + .env generation (macOS/Linux)
  start.ps1         — stop existing + start bridge (Windows)
  start.sh          — stop existing + start bridge (macOS/Linux)
  stop.ps1          — kill bridge by PID file + orphan sweep (Windows)
  stop.sh           — kill bridge by PID file + orphan sweep (macOS/Linux)
bridge.ps1          — CLI entry point (Windows)
bridge.sh           — CLI entry point (macOS/Linux)
skill/
  SKILL.md          — OpenClaw skill definition
  references/
    graph-api.md    — Graph API endpoint reference
```

### OpenClaw Agent Skill

The `skill/` directory contains an OpenClaw skill definition that teaches the agent about the bridge's capabilities — message formats, bridge tools, business rules, and security constraints.

For agent configuration and deployment, see the [Patchnet Agent Models](https://github.com/Patchnet/agent-models) repo.

---

## Token Management

The refresh token auto-rotates on every use and is saved back to `.env`. As long as the bridge runs at least once every 90 days, the token self-renews indefinitely.

**When you need to re-authenticate:**
- Bridge offline for 90+ days
- Agent account password changed
- Admin revokes app consent in Entra

---

## Deployment

Use the bridge CLI to manage the process:

**Windows:**

```powershell
.\bridge.ps1 start      # Start in background (auto-stops existing)
.\bridge.ps1 stop       # Stop gracefully
.\bridge.ps1 restart    # Stop + start
.\bridge.ps1 log        # Tail the bridge log
```

**macOS / Linux:**

```bash
./bridge.sh start
./bridge.sh stop
./bridge.sh restart
./bridge.sh logs
```

Or launch the interactive CLI with `./bridge.sh` (no arguments).

### Updating

After pulling new code from GitHub:

**Windows:**

```powershell
.\bridge.ps1 stop
git pull
npm install
.\bridge.ps1 start
```

**macOS / Linux:**

```bash
./bridge.sh stop
git pull
npm install
./bridge.sh start
```

---

## Email Integration

The bridge supports optional email integration with three tiers controlled by `EMAIL_MODE` in `.env`:

| Mode | Capabilities |
|---|---|
| `off` | Email features disabled entirely (default) |
| `read` | Read inbox, manage mailbox (move, delete, folders) — no sending |
| `full` | Everything in read + reply, compose, forward — all sends whitelist-gated |

### Setup

1. Add `Mail.ReadWrite` (and `Mail.Send` for full mode) to your app registration's API permissions in Azure
2. Grant admin consent for the new permissions
3. Re-run the setup script to get a refresh token with the expanded scopes:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-bridge.ps1
   ```
4. Add the following to your `.env`:
   ```ini
   EMAIL_MODE=full
   BOT_EMAIL=your-agent@yourdomain.com
   EMAIL_WHITELIST=*@yourdomain.com
   EMAIL_POLL_INTERVAL_MS=15000
   ```
5. Restart the bridge

### Whitelist

All outbound email operations (reply, send, forward) are gated by `EMAIL_WHITELIST`. This is enforced at the code level — the agent cannot disable or bypass it.

| Format | Matches |
|---|---|
| `user@example.com` | Exact address only |
| `*@example.com` | Any address at that domain |
| `example.com` | Same as `*@example.com` |
| `*` | Agent's own domain (requires `BOT_EMAIL` set) |

If `EMAIL_WHITELIST` is empty, **all outbound email is blocked** (fail-safe).

### Security Recommendations

- Block external inbound email to the agent account via Exchange transport rules
- Use `EMAIL_WHITELIST` to restrict replies to your own domain initially
- Monitor the agent's Sent Items folder for unexpected outbound messages

---

## Channel Management

The bridge monitors Teams channels the agent account is a member of. Each team operates in one of three modes:

| Mode | Behavior |
|---|---|
| `monitor` | Messages are **not** forwarded to the agent. The agent can read on demand via `get_channel_messages` tool. |
| `managed` | Only @mentions from users on the `ALLOWED_USERS` list are forwarded. Replies go in-thread. |
| `open` | All @mentions are forwarded regardless of sender. Replies go in-thread. |

New teams default to `monitor` mode. The bridge notifies the channel manager when a new team is detected.

### Managing Modes

The person configured as `CHANNEL_MANAGER` in `.env` controls modes by sending **DM commands** to the agent account in Teams.

> **Use your Entra Object ID**, not your UPN/email. Teams sends messages with the sender's object ID, and the bridge matches on that value. You can find your object ID in [Entra ID → Users](https://portal.azure.com/#view/Microsoft_AAD_IAM/UsersManagementMenuBlade/~/AllUsers) → your account → Object ID.

```
teams                          — list all teams and their current modes
set <team name> monitor        — stop forwarding messages from this team
set <team name> managed        — forward @mentions from allowed users only
set <team name> open           — forward all @mentions
```

**Examples:**

```
teams
set Sales managed
set Security open
set Marketing monitor
```

Only the designated channel manager can issue these commands. DMs from other users are processed normally through the agent.

### How Channel Messaging Works

When a team is in **managed** or **open** mode:

1. **@mention the agent** in a channel to start a conversation — the bridge detects the mention and forwards the message to the agent
2. The agent **replies in-thread** with an @mention back to the sender
3. **Follow-up replies** in that thread are automatically forwarded to the agent — no @mention needed
4. The bridge tracks active threads for **48 hours** — after that, a new @mention is required to re-engage

The bridge uses `$expand=replies` to fetch thread replies in a single API call per channel, keeping overhead low.

### Channel Limitations (Work in Progress)

Channel support is functional but has known limitations being actively worked on:

- **First message after mode change is missed** — when switching a team from `monitor` to `managed`/`open`, the bridge seeds its cursor on the first poll cycle. The first @mention sent during that window is consumed by seeding. Send a second @mention after ~10 seconds.
- **Thread tracking is in-memory** — restarting the bridge loses all tracked threads. Follow-up replies in previously active threads will require a new @mention to re-establish the conversation.
- **Channel ack is a separate reply** — the 6-second acknowledgment is posted as its own in-thread reply rather than edited in place, so busy channels will see a short "working on it" message followed by the final answer.
- **Polling delay** — channels are polled every 10 seconds, so there's up to a 10-second delay before an @mention is detected.
- **CHANNEL_MANAGER requires Entra Object ID** — UPN/email matching does not work because Teams sends the sender's object ID, not UPN. A future update will resolve UPN to object ID at startup.
- **Heavy first poll on startup** — seeding cursors for all channels in managed teams takes several seconds. Subsequent polls are fast.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

---

Built with ❤️ by [Luis](https://x.com/luisrmartinez) and the team at [Patchnet](https://x.com/patchnet).

Thank you to [OpenClaw](https://github.com/openclaw/openclaw) and its community.

Not affiliated with or endorsed by Microsoft Corporation or OpenClaw.

Hope this makes your day better.
