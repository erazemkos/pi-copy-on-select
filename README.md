# pi-copy-on-select

Copy-on-select for the [pi coding agent](https://github.com/earendil-works/pi-mono). Drag-select text in the chat viewport and it lands on your system clipboard, a small toast confirms it in the bottom right, and the highlight clears itself.

## Features

- **Copy on select** — mouse selections are copied on release, no `ctrl+c` needed. Double-click copies a whole line.
- **Self-clearing highlight** — the selection disappears after the copy: instantly, after a short linger (`fade`), or never.
- **Bottom-right toast** — a one-line "Copied to clipboard" confirmation that fades on its own. Fully optional.
- **Independent clipboard handling** — selections are reconstructed from raw mouse reports and read off the rendered viewport, so copying does not rely on any other extension's clipboard feature.
- **Runtime toggles** — `/copy-on-select` flips behavior for the current session without editing settings.

## Requirements

pi renders the chat transcript as terminal scrollback, so mouse selection has to be owned by something. This extension needs an editor that captures mouse reporting and paints the selection highlight — in practice [`pi-powerline-footer`](https://www.npmjs.com/package/pi-powerline-footer) with its fixed editor enabled (`powerline.fixedEditor` and `powerline.mouseScroll` are on by default).

When no such editor is active, the extension stays completely inert and your terminal keeps its native selection behavior.

If you use `pi-powerline-footer`, disable its own copy-on-select so the two do not both write the clipboard:

```json
{
  "powerline": {
    "copyOnSelect": false
  }
}
```

## Install

```bash
pi install npm:pi-copy-on-select
```

Or straight from git:

```bash
pi install git:github.com/erazemkos/pi-copy-on-select
```

Restart pi, or run `/reload`.

## Configuration

All settings live under `copyOnSelect` in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project, merged over global):

```json
{
  "copyOnSelect": {
    "enabled": true,
    "copy": true,
    "clearSelection": "fade",
    "fadeMs": 250,
    "toast": true,
    "toastText": "Copied to clipboard",
    "toastMs": 1500
  }
}
```

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. `"copyOnSelect": false` is accepted as shorthand. |
| `copy` | boolean | `true` | Write the selection to the system clipboard on mouse release. |
| `clearSelection` | `"immediate"` \| `"fade"` \| `"off"` | `"fade"` | When to drop the highlight after a copy. `true`/`false` are accepted as `"immediate"`/`"off"`. |
| `fadeMs` | number | `250` | Linger time before clearing, used by `"fade"` (0–5000). |
| `toast` | boolean | `true` | Show the bottom-right confirmation. |
| `toastText` | string | `"Copied to clipboard"` | Toast message. |
| `toastMs` | number | `1500` | How long the toast stays visible (200–10000). |

### `/copy-on-select`

Session-local overrides; settings files stay untouched.

| Command | Effect |
|---|---|
| `/copy-on-select` | Show current behavior |
| `/copy-on-select on` \| `off` | Enable or disable everything |
| `/copy-on-select toast on` \| `toast off` | Toggle the toast |
| `/copy-on-select clear immediate` \| `clear fade` \| `clear off` | Change highlight clearing |
| `/copy-on-select reload` | Re-read settings from disk |

## How it works

1. The extension wraps the TUI's input handler and watches SGR mouse reports (press, drag, release, wheel).
2. It wraps the TUI's render function to keep a snapshot of the visible chat lines, including selection styling.
3. On release it maps screen coordinates onto that snapshot, slices the selected columns (grapheme- and wide-character aware), strips ANSI, and copies the text.
4. The highlight is dropped by replaying a zero-width click, which the owning editor reads as "clicked without selecting".

Safety rails:

- Nothing happens unless an editor owns mouse reporting, and everything pauses while a TUI overlay is visible.
- If the selected rows change between press and release (scrolling, streaming output), the copy is skipped rather than copying stale text; the highlight is left in place so `ctrl+c` still works.
- Selections inside the fixed editor cluster are left to the owning editor; this extension only handles the chat viewport.

## Development

```bash
npm test
```

Tests are plain `node:test` files with no build step and no pi installation required: selection parsing, config merging, toast rendering, and the runtime are covered against a fake TUI.

## License

MIT © erazemkos

## Notes for packagers

pi bundles `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` and injects them into extensions. They are declared as optional peer dependencies so `npm install` inside a git clone of this package does not download a second copy of pi.
