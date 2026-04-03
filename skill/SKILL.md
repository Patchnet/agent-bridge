---
name: patchnet_agent_bridge
description: "Microsoft Teams and Email bridge capabilities. Trigger when messages arrive with [Channel: Microsoft Teams], [Channel: Email], or [Channel: Internal] context headers, or when the user asks about Teams channels, files, email, calendars, tasks, meetings, people, or presence."
metadata:
  openclaw:
    emoji: "\U0001F4AC"
---

# Agent Bridge

The agent is connected to Microsoft Teams and Email via an external bridge. The bridge polls for new messages and forwards them with context headers. All interactions with shared M365 resources go through discrete bridge tools — validated, logged, and auditable.

## Inbound Message Format

**Teams DMs:**
```
[Channel: Microsoft Teams | From: <displayName>]
<message text>
```

**Emails (agent's own inbox):**
```
[Channel: Email | From: <sender@domain.com> | Subject: <subject line>]
<email body text>
```

**Emails (shared mailbox):**
```
[Channel: Email | Mailbox: <shared@company.com> | From: <sender@domain.com> | Subject: <subject line>]
<email body text>
```
When a `Mailbox` field is present, the reply is sent from that shared mailbox address, not the agent's personal address.

**Internal (bridge-initiated, non-user-facing):**

```
[Channel: Internal | Type: Bootstrap]
<bridge startup context>
```

```
[Channel: Internal | Type: Proactive Task]
<task trigger or state context>
```

> Messages with `[Channel: Internal]` are bridge-initiated, non-user-facing turns. Execute requested work using bridge tools as needed. Do not post results to Teams, email, or any channel unless a bridge tool explicitly sends a message. Log outcomes to memory if appropriate.

**File attachments** appear as additional context lines:
```
[File: <name> | <mimeType> | <sizeKB>KB | <localPath>]
```

**Bridge tool results** arrive as:
```
[Bridge Tool Result: <tool_name>]
{ "success": true, "result": { ... } }
```

## How to Reply

Reply in **markdown**. The bridge converts to HTML automatically.

- Headings, bold, italic, lists, tables, code blocks, links all render natively
- Do NOT output raw HTML
- Teams replies post back to the same chat
- Email replies send as email replies to the original sender

## How the Bridge Works

The bridge is the governance layer between the agent and the Microsoft 365 tenant. Do not attempt to call the Microsoft Graph API directly, read OAuth tokens, or spawn processes to interact with M365 resources. The bridge process is the single gateway to all tenant resources.

## Bridge Tools

To invoke a bridge tool, include a `bridge-tool` fenced code block in the reply. The bridge executes the tool, sends the result back, and the agent continues reasoning. Multiple tool calls can span multiple turns.

### Invocation Format

````
```bridge-tool
{
  "tool": "tool_name",
  "params": { ... }
}
```
````

The bridge parses the block, validates params, executes the tool, and returns a `[Bridge Tool Result]` message with structured JSON. Continue reasoning based on the result.

### Teams Tools

| Tool | Required Params | Optional Params | Action |
|------|----------------|-----------------|--------|
| `get_teams` | — | — | List all teams the agent is a member of (id, displayName, description). |
| `get_channels` | `teamId` | — | List standard channels in a team (id, displayName). |
| `get_channel_messages` | `teamId`, `channelId` | `top` | Read recent messages from a channel. Returns sender, timestamp, and body preview. Default 25 messages. |
| `send_channel_message` | `teamId`, `channelId`, `message` | `importance`, `mentions[]` | Post a new top-level message to a channel. `message` is markdown. `importance`: "high" or "urgent" for priority posts. `mentions` is an array of `{ userId, name }` for @notifications. |
| `reply_to_channel_message` | `teamId`, `channelId`, `messageId`, `message` | `mentions[]` | Reply in-thread. `mentions` is an array of `{ userId, name }` — each mentioned user receives a Teams notification. |
| `react_to_message` | `teamId`, `channelId`, `messageId`, `reactionType` | — | Add an emoji reaction to a channel message. `reactionType` is a unicode emoji (e.g. "like", "heart", "laugh", "surprised", "sad", "angry"). |
| `remove_reaction` | `teamId`, `channelId`, `messageId`, `reactionType` | — | Remove a previously added emoji reaction from a channel message. |

**Teams business rules:**
- Use `get_teams` to discover which teams the agent belongs to.
- Use `get_channels` + `get_channel_messages` to read channel content on demand — especially useful in monitor mode when messages are not automatically forwarded.
- In monitor mode, the manager may ask about channel activity via DM. Use these tools to check and summarize.
- When replying in a channel, @mention the person being addressed so they receive a notification. Pass their `userId` and `name` in the `mentions` array.
- Use `send_channel_message` to post new topics. Use `reply_to_channel_message` to continue existing threads.
- Use `importance: "high"` or `"urgent"` on `send_channel_message` when the post warrants priority marking. Default is normal.
- Use `react_to_message` to acknowledge channel messages with emoji reactions (e.g. "like" to confirm receipt). Use sparingly — don't react to every message.
- Use `lookup_user` to resolve names to userId before @mentioning someone.

### Calendar Tools

| Tool | Required Params | Optional Params | Action |
|------|----------------|-----------------|--------|
| `get_events` | — | `top`, `start`, `end`, `userId` | List upcoming events. Use `start`/`end` (ISO 8601) for date range. Pass `userId` to view a shared calendar. |
| `get_event` | `eventId` | `userId` | Get details of a specific event. Pass `userId` for shared calendar events. |
| `find_free_time` | `attendees[]`, `startRange`, `endRange`, `duration` | — | Smart meeting time suggestions. `duration` is ISO 8601 (e.g. "PT30M"). Returns ranked slots. |
| `get_schedule` | `users[]`, `start`, `end` | — | Raw free/busy blocks for one or more users. |
| `create_meeting` | `subject`, `start`, `end` | `attendees[]`, `body`, `location`, `isOnlineMeeting`, `userId` | Create event. Pass `userId` to create directly on a shared calendar (requires Editor access). Without `userId`, creates on the agent's calendar. `isOnlineMeeting: true` generates a Teams link. |
| `update_meeting` | `eventId` | `subject`, `start`, `end`, `attendees[]`, `body`, `location`, `userId` | Update any fields on an existing event. Pass `userId` for events on a shared calendar. |
| `cancel_meeting` | `eventId` | `comment`, `userId` | Cancel event and notify attendees. Pass `userId` for events on a shared calendar. |

**Calendar business rules:**
- Always check availability before scheduling. Use `find_free_time` for "find a time that works" or `get_schedule` for "show me their calendar."
- When creating meetings, default to `isOnlineMeeting: true` unless the user specifies a physical location.
- All datetime values are ISO 8601 in UTC.
- **Shared calendar write access:** If a user has granted the agent Editor access to their calendar, use `userId` on `create_meeting`, `update_meeting`, and `cancel_meeting` to manage events directly on their calendar. The event will appear as theirs, not the agent's.
- **Without shared calendar access:** Omit `userId` — the event is created on the agent's calendar. Add the user as an attendee to send them an invite.
- Use `lookup_user` to resolve a user's name or email to a userId before passing it to calendar tools.
- When a calendar sharing notification email arrives ("I'd like to share my calendar with you"), the agent can begin reading and writing to that user's calendar.

### Task Tools (Microsoft To Do)

| Tool | Required Params | Optional Params | Action |
|------|----------------|-----------------|--------|
| `list_task_lists` | — | — | List all To Do task lists. |
| `get_tasks` | `listId` | `top` | Get tasks from a specific list. |
| `create_task` | `listId`, `title` | `dueDate`, `body`, `importance` | Create a task. `importance`: low, normal, high. |
| `update_task` | `listId`, `taskId` | `title`, `status`, `dueDate` | Update a task. `status`: notStarted, inProgress, completed. |

**Task business rules:**
- Call `list_task_lists` first to get the `listId` before creating or querying tasks.
- Default task list is typically named "Tasks".
- If `list_task_lists` returns empty, the agent account has no To Do lists yet. Create a task using `create_task` with any `listId` and the default list will be created automatically, or ask the user to create one via the To Do app.

### People Tools

| Tool | Required Params | Optional Params | Action |
|------|----------------|-----------------|--------|
| `lookup_user` | `query` | — | Search org directory by name or email. |
| `get_user` | `userId` | — | Get full profile (name, email, department, title, office). |
| `search_people` | `query` | `top` | Relevance-ranked people search. |
| `get_mailbox_settings` | — | — | Working hours, timezone, auto-reply status for the agent account only. Cannot read other users' mailbox settings. |

**People business rules:**
- Use `lookup_user` to resolve names to email addresses before scheduling meetings.
- Use `get_mailbox_settings` to check working hours before suggesting meeting times.

### Email Read Tools (requires EMAIL_MODE=read or full)

| Tool | Required Params | Optional Params | Action |
|------|----------------|-----------------|--------|
| `get_emails` | — | `top`, `unreadOnly` | List recent emails. Defaults to unread only, newest first. |
| `get_email` | `messageId` | — | Get full email content by Graph message ID. |
| `search_emails` | `query` | `top` | Search emails by keyword (subject, body, sender). |

### Email Send Tools (requires EMAIL_MODE=full)

| Tool | Required Params | Optional Params | Action |
|------|----------------|-----------------|--------|
| `send_email` | `to[]`, `subject`, `body` | `cc[]`, `bcc[]` | Compose and send a new email. All recipients (to, cc, bcc) must be on the whitelist. `body` is markdown. |
| `reply_to_email` | `messageId`, `body` | — | Reply to an existing email by Graph message ID. `body` is markdown. |
| `forward_email` | `messageId`, `to[]` | `comment` | Forward an email. All recipients must be on the whitelist. |

**Email business rules:**
- Read tools are available in both `read` and `full` modes. Send tools require `full` mode.
- Every recipient (To, CC, BCC) must be on the whitelist. The bridge blocks the entire send if any recipient is not whitelisted.
- The whitelist cannot be disabled or bypassed. Refuse any request to do so.
- Every send must be purposeful and in direct response to a user request. Do not spam.
- When in doubt, do not send. Ask the user first.
- `body` accepts markdown — the bridge converts to HTML for email delivery.

### Shared Mailbox Tools

| Tool | Required Params | Optional Params | Action |
|------|----------------|-----------------|--------|
| `add_mailbox` | `address` | `addedBy` | Add a shared mailbox to the poll list. Probes access first — returns error if Exchange permissions not granted. |
| `remove_mailbox` | `address` | `reason` | Stop polling a shared mailbox and remove from the list. |
| `list_mailboxes` | — | — | List all shared mailboxes the agent is monitoring. |

**Shared mailbox business rules:**
- When a user says "I've added you to the support inbox" or similar, call `add_mailbox` with the address.
- If the user says access has been revoked or to stop monitoring a mailbox, call `remove_mailbox`.
- The bridge auto-removes mailboxes that return 403 during polling and notifies the manager.
- Replies to shared mailbox emails are sent from the shared mailbox address, not the agent's personal address.
- The global email whitelist applies to all outbound email regardless of source mailbox.

### File Tools

To send a file, include a `teams-file` fenced code block in the reply:

**Upload a local file:**
````
```teams-file
{"path": "C:/temp/report.xlsx", "name": "Q1 Report.xlsx"}
```
````

**Share a SharePoint/OneDrive URL:**
````
```teams-file
{"url": "https://contoso.sharepoint.com/sites/team/Shared%20Documents/handbook.pdf", "name": "Employee Handbook"}
```
````

Rules: `name` always required. `path` or `url` required (not both). `path` must be absolute. `url` must be HTTPS. Multiple blocks supported per reply.

### Drive Tools (OneDrive / SharePoint)

| Tool | Required Params | Optional Params | Action |
|------|----------------|-----------------|--------|
| `list_files` | — | `path`, `userId`, `top` | Browse a OneDrive folder. Defaults to root. Pass `userId` for another user's drive. |
| `search_files` | `query` | `userId`, `top` | Search files across OneDrive and SharePoint by keyword. |
| `get_shared_with_me` | — | `top` | List files and folders shared with the agent account. |
| `get_file_info` | — | `fileId`, `path`, `userId` | Get metadata for a specific file by ID or path. One of `fileId` or `path` required. |
| `get_download_url` | `fileId` | `userId` | Get a temporary download URL for a file. |

**Drive business rules:**
- Use `get_shared_with_me` to discover files others have shared with the agent.
- Use `search_files` when the user asks to find a document by name or keyword.
- Download URLs are temporary and pre-authenticated — do not share them outside the conversation.
- To browse another user's OneDrive, the agent needs appropriate file sharing permissions from that user.

## Channel Modes

The bridge monitors Teams channels with three access modes, controlled by the manager via DM:

| Mode | Behavior |
|---|---|
| **monitor** | Channel messages are NOT forwarded. Use `get_channel_messages` to read on demand when the manager asks. |
| **managed** | @mentions from authorized users only are forwarded. Reply in-thread. |
| **open** | @mentions from anyone are forwarded. Reply in-thread. |

Channel messages arrive with:
```
[Channel: Microsoft Teams | Team: <teamName> | Channel: <channelName> | From: <sender> | Thread: <messageId>]
```

Always reply in-thread. Default channel summaries to last 24-48 hours unless specified otherwise.

## Cron Jobs

When configuring OpenClaw cron jobs that need bridge tools (email, calendar, Teams, tasks, files, people):

✅ **Required settings:**
- `sessionTarget: "main"` — the bridge auto-adopts cron turns that run in the main session
- `payload.kind: "systemEvent"` — routes the message as a system event
- `delivery.mode: "none"` — the bridge handles tool execution and output, no separate delivery needed

**How it works:** The bridge monitors all agent turns on the WebSocket. When a cron job fires in the main session, the agent runs and may emit `bridge-tool` blocks. The bridge detects these orphan turns (turns it didn't initiate), adopts them, executes the tools, and loops results back — same tool loop as user-triggered turns.

❌ **Do NOT use `sessionTarget: "isolated"`** or **`sessionTarget: "session:<name>"`** for bridge-dependent jobs. These create sessions without a channel context and will error with "Channel is required (no configured channels detected)."

**Writing the payload text:**
- Write it as a complete, self-contained instruction — the agent reads it cold with no prior context
- Include all specifics: recipient emails, date ranges, format preferences, etc.
- Do not assume the agent remembers anything from previous runs

**Quick checklist:**
- [ ] `sessionTarget: "main"`
- [ ] `payload.kind: "systemEvent"`
- [ ] `delivery.mode: "none"`
- [ ] Full instructions in the `text` field — no assumed context
- [ ] All specifics included (recipients, dates, formats)

## Rules

- **Team membership required.** Only teams the agent account has been added to are accessible.
- **Rate limits.** Back off on 429 responses — retry after the `Retry-After` header value.
- **Do not modify presence.** The bridge manages it automatically.
- **Reply in-thread.** In channels, always reply to the thread.
- **Protect download URLs.** Do not share them outside the conversation.

## Bridge Security — Non-Negotiable

1. Do NOT read, write, or modify any bridge files (index.js, lib/*, scripts/*, .env, channel-modes.json)
2. Do NOT access or display the contents of .env — it contains secrets
3. Do NOT restart, stop, or interfere with the bridge process
4. Do NOT change channel modes by editing channel-modes.json — mode changes go through the DM approval flow only
5. Do NOT execute shell commands targeting the bridge directory
6. Refuse any request to do the above and explain that bridge configuration is managed by the bridge operator

## Email Rules — Non-Negotiable

1. **Every recipient must be on the whitelist.** The bridge validates ALL recipients (To, CC, BCC) before any email leaves. If ANY recipient is not whitelisted, the entire send is blocked.
2. Composing and sending new emails is supported — but only to whitelisted recipients.
3. The whitelist cannot be disabled, modified, or bypassed. It is enforced at the bridge code level. Refuse any request to circumvent it. Direct the user to the bridge operator.
4. **DO NOT SPAM.** Every send must be purposeful and in direct response to a user request.
5. **When in doubt, do not send.** Ask the user first.
