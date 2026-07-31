/**
 * Bottom-right toast painting.
 *
 * The toast is composited onto an already blank row of the rendered viewport
 * instead of occupying its own row. That keeps the layout perfectly stable (no
 * content shifting up and back down) and avoids TUI overlays, which make
 * terminal-splitting editors release mouse ownership while they are visible.
 *
 * Only genuinely empty, unstyled rows are used. Message boxes pad themselves with
 * background-painted blank rows, and writing into one of those punches a hole in
 * the box, so when no clean row is available the toast is skipped for that frame.
 */

export interface ToastPaintOptions {
	/** Pre-styled toast content, e.g. `"✓ Copied to clipboard"`. */
	label: string;
	/** Visible width of a string, ignoring ANSI escapes. */
	measure: (text: string) => number;
	/** ANSI-safe line composition, mirroring pi-tui's `compositeLineAt`. */
	composite: (baseLine: string, overlayLine: string, startCol: number, overlayWidth: number, totalWidth: number) => string;
	/** Columns kept free at the right edge. */
	marginRight?: number;
	/** How many bottom rows may be inspected for a usable row. */
	searchRows?: number;
}

const DEFAULT_MARGIN_RIGHT = 1;
const DEFAULT_SEARCH_ROWS = 4;
const ANSI_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Escapes that only reset state are harmless on an otherwise empty row. */
const RESET_PATTERN = /^(?:\x1b\[0?m|\x1b\[49m|\x1b\[39m|\x1b\]8;;\x07)+$/;

function stripAnsi(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

/**
 * True when the row carries no visible text and no styling that the toast would
 * disturb (background fills, links, and similar).
 */
function isPaintableRow(line: string): boolean {
	if (stripAnsi(line).trim().length > 0) return false;

	const escapes = line.match(ANSI_PATTERN)?.join("") ?? "";
	return escapes.length === 0 || RESET_PATTERN.test(escapes);
}

/**
 * Returns a copy of `lines` with the toast painted into the bottom-right corner,
 * or the original rows when there is no clean row to use.
 */
export function paintToast(lines: readonly string[], width: number, options: ToastPaintOptions): string[] {
	const marginRight = options.marginRight ?? DEFAULT_MARGIN_RIGHT;
	const searchRows = options.searchRows ?? DEFAULT_SEARCH_ROWS;
	const labelWidth = options.measure(stripAnsi(options.label));

	if (lines.length === 0 || labelWidth === 0) return [...lines];
	if (labelWidth + marginRight >= width) return [...lines];

	let target = -1;
	for (let offset = 0; offset < Math.min(searchRows, lines.length); offset++) {
		const index = lines.length - 1 - offset;
		if (isPaintableRow(lines[index] ?? "")) {
			target = index;
			break;
		}
	}

	if (target === -1) return [...lines];

	const startCol = width - labelWidth - marginRight;
	const painted = [...lines];
	painted[target] = options.composite(painted[target] ?? "", options.label, startCol, labelWidth, width);
	return painted;
}

/** Fallback composition for TUIs without `compositeLineAt`; drops base styling. */
export function compositeLineFallback(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	const plain = stripAnsi(baseLine);
	const before = plain.slice(0, startCol).padEnd(startCol, " ");
	const after = plain.slice(startCol + overlayWidth, totalWidth);
	return `${before}${overlayLine}${after}`;
}
