/**
 * Selection fade-out.
 *
 * The editor that owns the viewport paints selections with reverse video
 * (`ESC[7m` … `ESC[27m`). Reverse video has no intensity to animate, so a fade is
 * produced by rewriting those spans into an explicit background colour and
 * stepping that colour down a ramp before the selection is dropped entirely.
 *
 * Rewriting is background-aware: message boxes paint a background across the
 * whole row, so the code that ends a faded span restores the background that was
 * active before it instead of blindly resetting to the terminal default.
 */

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const REVERSE_ON_MARKER = "\x1b[7m";
const REVERSE_OFF_MARKER = "\x1b[27m";
const DEFAULT_BACKGROUND = "\x1b[49m";

/**
 * Default ramp of xterm-256 colour indexes, tuned for dark themes: a light grey
 * block that sinks toward the background.
 */
export const DEFAULT_FADE_COLORS = [252, 247, 242, 238, 235];

/** True when the frame still contains a reverse-video selection. */
export function hasSelection(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes(REVERSE_ON_MARKER));
}

/** Returns the background-setting escape for `params`, or null when it sets none. */
function backgroundFor(params: string): string | null {
	if (params === "" || params === "0") return "";

	const codes = params.split(";").map((value) => Number(value));
	for (let index = 0; index < codes.length; index++) {
		const code = codes[index];
		if (code === 0) return "";
		if (code === 49) return "";
		if (code !== undefined && code >= 40 && code <= 47) return `\x1b[${code}m`;
		if (code === 48) {
			// 48;5;N or 48;2;R;G;B
			const mode = codes[index + 1];
			const length = mode === 5 ? 3 : mode === 2 ? 5 : 0;
			if (length === 0) return null;
			return `\x1b[${codes.slice(index, index + length).join(";")}m`;
		}
	}

	return null;
}

/**
 * Rewrites reverse-video selections in one line as the given xterm-256 background,
 * restoring whatever background was active when each span ends.
 */
function fadeLine(line: string, background: string): string {
	if (!line.includes(REVERSE_ON_MARKER)) return line;

	let result = "";
	let cursor = 0;
	let activeBackground = "";
	let inSelection = false;

	SGR_PATTERN.lastIndex = 0;
	for (let match = SGR_PATTERN.exec(line); match !== null; match = SGR_PATTERN.exec(line)) {
		const sequence = match[0];
		result += line.slice(cursor, match.index);
		cursor = match.index + sequence.length;

		if (sequence === REVERSE_ON_MARKER) {
			inSelection = true;
			result += background;
			continue;
		}

		if (sequence === REVERSE_OFF_MARKER && inSelection) {
			inSelection = false;
			result += activeBackground === "" ? DEFAULT_BACKGROUND : activeBackground;
			continue;
		}

		const nextBackground = backgroundFor(match[1] ?? "");
		if (nextBackground !== null && !inSelection) activeBackground = nextBackground;
		result += sequence;
	}

	return result + line.slice(cursor);
}

/**
 * Returns a copy of `lines` with reverse-video selections repainted as the given
 * xterm-256 background colour.
 */
export function applyFade(lines: readonly string[], color: number): string[] {
	const background = `\x1b[48;5;${Math.max(0, Math.min(255, Math.round(color)))}m`;

	return lines.map((line) => fadeLine(line, background));
}

/** Normalizes a configured ramp, falling back to the default. */
export function normalizeFadeColors(value: unknown): number[] {
	if (!Array.isArray(value)) return [...DEFAULT_FADE_COLORS];

	const colors = value
		.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
		.map((entry) => Math.max(0, Math.min(255, Math.round(entry))));

	return colors.length > 0 ? colors : [...DEFAULT_FADE_COLORS];
}

/**
 * Per-step duration for a fade. The ramp gets `colors.length` steps and the final
 * step removes the selection, so the whole animation lasts about `durationMs`.
 */
export function fadeStepMs(durationMs: number, steps: number): number {
	if (steps <= 0) return Math.max(0, durationMs);
	return Math.max(1, Math.round(durationMs / steps));
}
