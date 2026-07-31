/**
 * Pure selection primitives: SGR mouse parsing, column slicing, and selection
 * text extraction. Everything here is dependency-free so it can be unit tested
 * without a terminal; width measurement is injected by the caller.
 */

/** Measures the visible width of a string (ANSI-free input). */
export type Measure = (text: string) => number;

export interface MousePacket {
	code: number;
	/** 1-based terminal column. */
	col: number;
	/** 1-based terminal row. */
	row: number;
	press: boolean;
	drag: boolean;
	release: boolean;
	button: number;
}

export interface Point {
	/** 1-based terminal row. */
	row: number;
	/** 0-based column inside the rendered line. */
	col: number;
}

export interface SelectionRange {
	start: Point;
	end: Point;
}

const SGR_MOUSE_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const TRAILING_BLANKS_PER_LINE = /[ \t]+$/gm;

export const DOUBLE_CLICK_MS = 500;

function baseButton(code: number): number {
	return code & ~(4 | 8 | 16 | 32);
}

/** Parses every SGR mouse report contained in `data`. */
export function parseSgrMousePackets(data: string): MousePacket[] {
	if (!data.includes("\x1b[<")) return [];

	const packets: MousePacket[] = [];
	for (const match of data.matchAll(SGR_MOUSE_PATTERN)) {
		const code = Number(match[1]);
		const release = match[4] === "m";
		const button = baseButton(code);
		const motion = (code & 32) !== 0;
		packets.push({
			code,
			col: Number(match[2]),
			row: Number(match[3]),
			button,
			release,
			press: !release && !motion,
			drag: !release && motion,
		});
	}

	return packets;
}

export function isLeftPress(packet: MousePacket): boolean {
	return packet.press && packet.button === 0;
}

export function isLeftDrag(packet: MousePacket): boolean {
	return packet.drag && packet.button === 0;
}

export function isLeftRelease(packet: MousePacket): boolean {
	return packet.release && packet.button === 0;
}

export function isWheel(packet: MousePacket): boolean {
	return !packet.release && (packet.button === 64 || packet.button === 65);
}

export function stripAnsi(line: string): string {
	return line.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
}

/** Slices `text` by visible columns, keeping grapheme clusters intact. */
export function sliceColumns(text: string, startCol: number, endCol: number, measure: Measure): string {
	if (endCol <= startCol) return "";

	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let col = 0;
	let result = "";
	for (const { segment } of segmenter.segment(text)) {
		if (col >= endCol) break;
		if (col >= startCol) result += segment;
		col += Math.max(0, measure(segment));
	}

	return result;
}

/** Orders two points top-to-bottom, left-to-right. */
export function orderPoints(a: Point, b: Point): SelectionRange {
	if (a.row === b.row) {
		return a.col <= b.col ? { start: a, end: b } : { start: b, end: a };
	}
	return a.row < b.row ? { start: a, end: b } : { start: b, end: a };
}

export function isEmptyRange(range: SelectionRange): boolean {
	return range.start.row === range.end.row && range.start.col === range.end.col;
}

/**
 * Extracts the selected text from rendered screen lines.
 * `lines[0]` must be the content of terminal row 1.
 */
export function extractSelectionText(lines: readonly string[], range: SelectionRange, measure: Measure): string {
	const parts: string[] = [];
	for (let row = range.start.row; row <= range.end.row; row++) {
		const line = lines[row - 1];
		if (line === undefined) return "";

		const plain = stripAnsi(line);
		const startCol = row === range.start.row ? range.start.col : 0;
		const endCol = row === range.end.row ? range.end.col : Number.POSITIVE_INFINITY;
		parts.push(sliceColumns(plain, startCol, endCol, measure));
	}

	return parts.join("\n").replace(TRAILING_BLANKS_PER_LINE, "").trimEnd();
}

/** Full-line range used for double-click selections. */
export function lineRange(lines: readonly string[], row: number, measure: Measure): SelectionRange | null {
	const line = lines[row - 1];
	if (line === undefined) return null;

	return { start: { row, col: 0 }, end: { row, col: measure(stripAnsi(line)) } };
}

/**
 * True when every row touched by the selection still renders the same text as
 * when the drag started. Guards against copying stale text after the viewport
 * scrolled or new output arrived mid-drag.
 */
export function rowsUnchanged(before: readonly string[], after: readonly string[], range: SelectionRange): boolean {
	for (let row = range.start.row; row <= range.end.row; row++) {
		const previous = before[row - 1];
		const current = after[row - 1];
		if (previous === undefined || current === undefined) return false;
		if (stripAnsi(previous) !== stripAnsi(current)) return false;
	}

	return true;
}

export interface SelectionTrackerOptions {
	measure: Measure;
	now?: () => number;
	doubleClickMs?: number;
}

/**
 * Reconstructs mouse selections over the rendered chat viewport.
 *
 * The tracker is intentionally independent of any other extension: it consumes
 * raw SGR mouse reports plus a snapshot of the rendered lines, and reports the
 * selected text once the mouse is released.
 */
export class SelectionTracker {
	private readonly measure: Measure;
	private readonly now: () => number;
	private readonly doubleClickMs: number;

	private anchor: Point | null = null;
	private focus: Point | null = null;
	private dragging = false;
	private wholeLine = false;
	private pressSnapshot: readonly string[] = [];
	private lastPress: { row: number; at: number } | null = null;

	constructor(options: SelectionTrackerOptions) {
		this.measure = options.measure;
		this.now = options.now ?? (() => Date.now());
		this.doubleClickMs = options.doubleClickMs ?? DOUBLE_CLICK_MS;
	}

	reset(): void {
		this.anchor = null;
		this.focus = null;
		this.dragging = false;
		this.wholeLine = false;
		this.pressSnapshot = [];
		this.lastPress = null;
	}

	/**
	 * Feeds one mouse report. `snapshot` is the currently rendered chat viewport.
	 * Returns the selected text when the release completes a selection.
	 */
	handlePacket(packet: MousePacket, snapshot: readonly string[]): string | null {
		if (isWheel(packet)) {
			// Scrolling invalidates screen coordinates captured so far.
			this.dragging = false;
			this.anchor = null;
			this.focus = null;
			this.lastPress = null;
			return null;
		}

		if (isLeftPress(packet)) {
			this.onPress(packet, snapshot);
			return null;
		}

		if (isLeftDrag(packet) && this.dragging) {
			if (!this.wholeLine) this.focus = this.pointFor(packet);
			return null;
		}

		if (isLeftRelease(packet) && this.dragging) {
			return this.onRelease(packet, snapshot);
		}

		return null;
	}

	private onPress(packet: MousePacket, snapshot: readonly string[]): void {
		const point = this.pointFor(packet);
		const at = this.now();
		const isDoubleClick =
			this.lastPress !== null && this.lastPress.row === point.row && at - this.lastPress.at <= this.doubleClickMs;

		this.pressSnapshot = [...snapshot];
		this.dragging = true;
		this.wholeLine = false;

		if (isDoubleClick) {
			const range = lineRange(snapshot, point.row, this.measure);
			if (range) {
				this.anchor = range.start;
				this.focus = range.end;
				this.wholeLine = true;
				this.lastPress = null;
				return;
			}
		}

		this.anchor = point;
		this.focus = point;
		this.lastPress = { row: point.row, at };
	}

	private onRelease(packet: MousePacket, snapshot: readonly string[]): string | null {
		const anchor = this.anchor;
		let focus = this.focus;
		this.dragging = false;

		if (!anchor || !focus) return null;
		if (!this.wholeLine) focus = this.pointFor(packet);

		const range = orderPoints(anchor, focus);
		if (isEmptyRange(range)) return null;
		if (!rowsUnchanged(this.pressSnapshot, snapshot, range)) return null;

		const text = extractSelectionText(snapshot, range, this.measure);
		if (text.length === 0) return null;

		this.lastPress = this.wholeLine ? null : this.lastPress;
		return text;
	}

	private pointFor(packet: MousePacket): Point {
		return { row: Math.max(1, packet.row), col: Math.max(0, packet.col - 1) };
	}
}
