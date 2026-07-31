/**
 * Bottom-right toast painting.
 *
 * The toast is composited onto the tail of an already rendered viewport line
 * instead of occupying its own row. That keeps the layout perfectly stable (no
 * content shifting up and back down) and avoids TUI overlays, which make
 * terminal-splitting editors release mouse ownership while they are visible.
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
	/** How many bottom rows may be inspected for a blank tail. */
	searchRows?: number;
}

const DEFAULT_MARGIN_RIGHT = 1;
const DEFAULT_SEARCH_ROWS = 3;
const ANSI_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

/** True when columns `[startCol, endCol)` of `line` contain nothing but blanks. */
function tailIsBlank(line: string, startCol: number, endCol: number): boolean {
	const plain = stripAnsi(line);
	return plain.slice(startCol, endCol).trim().length === 0 && plain.length <= endCol;
}

/**
 * Returns a copy of `lines` with the toast painted into the bottom-right corner,
 * or the original array when it does not fit.
 */
export function paintToast(lines: readonly string[], width: number, options: ToastPaintOptions): string[] {
	const marginRight = options.marginRight ?? DEFAULT_MARGIN_RIGHT;
	const searchRows = options.searchRows ?? DEFAULT_SEARCH_ROWS;
	const labelWidth = options.measure(stripAnsi(options.label));

	if (lines.length === 0 || labelWidth === 0) return [...lines];
	if (labelWidth + marginRight >= width) return [...lines];

	const startCol = width - labelWidth - marginRight;
	const endCol = startCol + labelWidth;

	// Prefer a bottom row whose tail is empty so nothing readable gets covered.
	let target = lines.length - 1;
	for (let offset = 0; offset < Math.min(searchRows, lines.length); offset++) {
		const index = lines.length - 1 - offset;
		if (tailIsBlank(lines[index] ?? "", startCol, endCol)) {
			target = index;
			break;
		}
	}

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
