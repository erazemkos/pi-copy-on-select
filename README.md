# pi-copy-on-select

Copy-on-select for the [pi coding agent](https://github.com/earendil-works/pi-mono). Drag-select text in the chat viewport and it lands on your system clipboard, a small toast confirms it in the bottom right, and the highlight clears itself.

## Features

- **Copy on select** — mouse selections are copied on release, no `ctrl+c` needed. Double-click copies a whole line.
- **Self-clearing highlight** — the selection fades out after the copy, or disappears at once, or lingers, or stays put. The fade is a real dimming animation, not just a delay.
- **Bottom-right toast** — a "Copied to clipboard" confirmation painted into the bottom-right corner. It reuses the last viewport row instead of adding one, so nothing on screen shifts. Fully optional.
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
    "fadeMs": 400,
    "delayMs": 250,
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
| `clearSelection` | `"immediate"` \| `"fade"` \| `"delayed"` \| `"keep"` | `"fade"` | What happens to the highlight after a copy. |
| `fadeMs` | number | `400` | Fade duration used by `"fade"` (60–5000). |
| `fadeColors` | number[] | `[252, 247, 242, 238, 235]` | xterm-256 colour indexes the fade steps through. |
| `delayMs` | number | `250` | Linger time used by `"delayed"` (0–5000). `0` behaves like `"immediate"`. |
| `toast` | boolean | `true` | Show the bottom-right confirmation. |
| `toastText` | string | `"Copied to clipboard"` | Toast message. |
| `toastMs` | number | `1500` | How long the toast stays visible (200–10000). |

`clearSelection` modes:

- `fade` — the highlight dims through `fadeColors` over `fadeMs`, then disappears.
- `immediate` — the highlight is gone as soon as you release the mouse.
- `delayed` — the highlight stays fully lit for `delayMs`, then disappears.
- `keep` — the highlight stays until you dismiss it (click elsewhere, or `ctrl+c` to copy again).

`false` and `"off"` are accepted as `"keep"`, `true` as `"immediate"`.

### Tuning the fade

Editors paint selections with reverse video, which has no intensity to animate. The fade therefore rewrites those spans into an explicit background colour and steps it down a ramp. The default ramp suits dark themes; on a light background invert it:

```json
{
  "copyOnSelect": {
    "clearSelection": "fade",
    "fadeMs": 300,
    "fadeColors": [250, 252, 253, 254, 255]
  }
}
```

More entries mean a smoother fade; each entry gets `fadeMs / fadeColors.length` on screen. Requires a terminal with xterm-256 colour support (all modern ones qualify). An empty ramp falls back to clearing immediately.

### `/copy-on-select`

Session-local overrides; settings files stay untouched.

| Command | Effect |
|---|---|
| `/copy-on-select` | Show current behavior |
| `/copy-on-select on` \| `off` | Enable or disable everything |
| `/copy-on-select toast on` \| `toast off` | Toggle the toast |
| `/copy-on-select clear immediate` \| `clear fade` \| `clear delayed` \| `clear keep` | Change highlight clearing |
| `/copy-on-select reload` | Re-read settings from disk |
| `/copy-on-select status` | Report config plus hook/mouse ownership (useful when something looks inert) |

## How it works

1. The extension wraps the TUI's input handler and watches SGR mouse reports (press, drag, release, wheel).
2. It wraps the TUI's render function to keep a snapshot of the visible chat lines, including selection styling.
3. On release it maps screen coordinates onto that snapshot, slices the selected columns (grapheme- and wide-character aware), strips ANSI, and copies the text.
4. The highlight is dropped by replaying a zero-width click, which the owning editor reads as "clicked without selecting".
5. While fading, the reverse-video spans in each frame are rewritten to a background colour that steps down the ramp; the selection itself is dropped after the last step.
6. The toast is composited onto a genuinely blank bottom row (using pi-tui's `compositeLineAt`). Nothing is added to the layout, so no content moves and no overlay is created — visible overlays would make the owning editor release mouse ownership. Message boxes pad themselves with background-filled blank rows, so those are never used; if no clean row exists in the bottom few, the toast is skipped for that frame rather than punching a hole in a box.

Hook ownership matters here. Editors like pi-powerline-footer tear down and rebuild their own render hook (first keypress, `/powerline ...`, resizes), and `/reload` re-imports this extension while the TUI object survives. The hooks are therefore stored on the TUI under a global symbol: the render hook is re-asserted as the outermost wrapper on every input, and a reloaded instance takes ownership from the previous one instead of stacking on top of it or sitting idle behind it.

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
