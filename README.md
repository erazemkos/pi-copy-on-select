# pi-copy-on-select

> [!WARNING]
> **Deprecated. Do not install this package.**
>
> Current Pi provides copy-on-select directly in fullscreen mode. A reliable,
> dependency-free implementation is not possible in regular mode because the
> terminal—not Pi—owns regular-mode selection.

Repository remains available as historical reference. No further releases or maintenance are planned.

## Replacement

Use Pi's built-in fullscreen selection:

```bash
pi --tui-mode fullscreen
```

Or make fullscreen mode persistent in `~/.pi/agent/settings.json`:

```json
{
  "tuiMode": "fullscreen",
  "fullscreenCopyOnSelect": true
}
```

Pi fullscreen mode provides:

- mouse text selection;
- automatic clipboard copy on release;
- built-in `Copied!` confirmation;
- transcript scrolling and selection mapping maintained by Pi itself.

See [Pi TUI documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md).

## Why regular mode cannot be supported

Pi regular mode deliberately delegates selection and scrollback to terminal emulator. Terminal consumes mouse drag and release events internally. Pi receives no standard event containing:

- selection start or end coordinates;
- selected text;
- notification that selection completed.

Without that information, extension cannot reliably copy selection, show confirmation toast, fade highlight, or clear selection.

Extension could enable terminal mouse-reporting modes and build its own selection engine, but that would:

- disable normal terminal-owned selection and wheel scrollback;
- prevent reliable selection of historical terminal scrollback;
- require private Pi viewport and renderer internals;
- require custom scrolling, highlighting, resize handling, and terminal cleanup;
- effectively recreate Pi fullscreen mode under another name.

That approach would be fragile, terminal-dependent, and worse than Pi's maintained native implementation.

## Why original integration stopped working

Original package relied on `pi-powerline-footer` fixed editor to own mouse reporting, viewport rendering, and selection highlighting. That fixed editor entered alternate screen and acted as custom fullscreen compositor.

`pi-powerline-footer` removed extension-owned fixed editor after Pi gained native fullscreen input and scrolling. Current powerline versions therefore no longer expose mouse-selection mechanism this package required.

Keeping package alive would mean either depending on obsolete plugin internals or duplicating functionality now owned by Pi. Neither is maintainable.

## Regular-mode alternative

Configure copy-on-select in terminal emulator if regular mode is required. This can copy terminal-native selections, but Pi extensions cannot observe operation, display Pi toast, animate selection, or clear it automatically.

## Package status

- GitHub repository: archived after deprecation process completes.
- npm package: all published versions deprecated, not unpublished.
- Final published version: `0.5.1`.
- Security fixes: none planned; package should be removed.

Remove installed package with:

```bash
pi remove npm:pi-copy-on-select
```

## License

MIT © erazemkos
