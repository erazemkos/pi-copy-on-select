# Changelog

## 0.3.0

- Fixed the extension going inert after `/reload`. Hooks are now registered on the
  TUI under a global symbol, so a reloaded instance takes ownership from the
  previous one. Previously the stale instance kept the hooks (with its old config
  and a dead session context) while the fresh instance never received input.
- The render hook is re-asserted as the outermost wrapper on every input, so the
  captured frame stays the on-screen viewport after a surrounding editor tears its
  own hook down and rebuilds it (pi-powerline-footer does this on the first
  keypress, on `/powerline ...` commands, and on resizes).
- Added `/copy-on-select status` reporting config plus hook/mouse ownership, and a
  warning when pre-0.3 hooks are still attached (restart pi to clear them).

## 0.2.0

- Toast is now painted into the bottom-right corner of an existing viewport row
  instead of being registered as a below-editor widget. The widget version added a
  row (shifting the transcript up and back down) and could flash mid-screen for a
  frame before the surrounding editor re-laid out its cluster.
- `clearSelection` modes renamed to `immediate` (new default), `delayed`, and
  `keep`, with `delayMs` replacing `fadeMs`. The old `fade`/`off`/boolean spellings
  are still accepted. `delayed` is documented as a linger rather than a visual fade,
  because the highlight is inverse-video painted by the editor that owns the
  viewport.
- `/copy-on-select clear ...` accepts the new mode names.

## 0.1.0

- Initial release: copy-on-select for the pi chat viewport, self-clearing highlight
  (`immediate`/`fade`/`off`), bottom-right toast, `copyOnSelect` settings block, and
  the `/copy-on-select` command.
