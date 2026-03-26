# Teams Formatting Guide

## Supported Markdown in Microsoft Teams

When sending messages from OpenClaw to Teams via this bridge, use the following markdown syntax:

### ✅ **Supported Formatting:**

- **Bold text:** `**text**` or `__text__`
- *Italic text:* `*text*` or `_text_`
- `Inline code:` `` `code` ``
- [Links](https://example.com): `[text](url)`
- Headings: `## Heading` or `### Subheading`
- Emoji: 👍 ✅ 🚀 💡 📊

**Lists:**
- Bullet lists: `- item` or `* item`
- Numbered lists: `1. item`

**Tables:**
```
| Column 1 | Column 2 |
|----------|----------|
| Data     | Data     |
```

**Horizontal rules:** `---`

**Blockquotes:** `> quoted text`

---

### ⚠️ **Code Formatting:**

**Known Issue:** Teams Graph API has a bug where `<codeblock>` tags get corrupted if there's inline `<code>` earlier in the message (reported Jan 2026, still unfixed).

**Our Approach:**
- **Use HTML formatting** (`contentType: "html"`)
- **Inline code ONLY** — use `<code>` tags for all code snippets
- **NO code blocks** — avoid `<codeblock>` until Microsoft fixes the bug

**Example:**
```json
{
  "body": {
    "content": "<p>Run this command: <code>Get-ChildItem -Path C:\\Users</code></p>",
    "contentType": "html"
  }
}
```

**For longer code:**
- Save to workspace file and reference the path
- Example: "I've saved the script to <code>workspace/scripts/example.ps1</code>"

---

## Implementation Note

This bridge prepends channel context to messages:
```
[Channel: Microsoft Teams | From: {displayName}]
```

OpenClaw sees this metadata and knows the message came from Teams, allowing context-aware responses.

---

---

## March 19, 2026 — Formatting Rewrite

`markdownToHtml()` in `lib/teams.js` was rewritten as a proper line-by-line parser.

**Problems fixed:**
- Inline code mixed with text caused paragraph fragmentation (text fell into broken code blocks)
- Hyperlinks `[text](url)` were not converted — links not clickable
- List `<ul>` wrapping via regex was fragile — items not grouped correctly
- Table rendering lacked `<thead>`/`<tbody>` distinction
- Outer wrapper was `<p>` instead of `<div>` (Graph API uses `<div>`)

**How it works now:**
- Line-by-line parser with explicit handlers for: fenced code blocks, headers, tables, ul, ol, blank lines, paragraphs
- `applyInline()` handles inline formatting with placeholder protection for code spans — formatting inside backticks is safe
- `escapeHtml()` runs first before any formatting
- `buildTable()` generates proper `<thead>/<tbody>` with `<th>/<td>`
- `<codeblock>` used for code blocks only when no inline code in the same message (avoids MS bug)

**Backup:** `lib/teams.js.bak-2026-03-19`

## Related Files

- `lib/openclaw.js` — WebSocket message formatting
- `lib/teams.js` — Teams API polling & message handling
- `.env` — Configuration (tenant, client ID, cert thumbprint)
