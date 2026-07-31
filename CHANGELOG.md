# Changelog

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
