/**
 * Selection fade-out.
 *
 * The editor that owns the viewport paints selections with reverse video
 * (`ESC[7m` … `ESC[27m`). Reverse video has no intensity to animate, so a fade is
 * produced by rewriting those spans into an explicit background colour and
 * stepping that colour down a ramp before the selection is dropped entirely.
 */

const REVERSE_ON = /\x1b\[7m/g;
const REVERSE_OFF = /\x1b\[27m/g;
const REVERSE_ON_MARKER = "\x1b[7m";

/**
 * Default ramp of xterm-256 colour indexes, tuned for dark themes: a light grey
 * block that sinks toward the background.
 */
export const DEFAULT_FADE_COLORS = [252, 247, 242, 238, 235];

/** True when the frame still contains a reverse-video selection. */
export function hasSelection(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes(REVERSE_ON_MARKER));
}

/**
 * Returns a copy of `lines` with reverse-video selections repainted as the given
 * xterm-256 background colour.
 */
export function applyFade(lines: readonly string[], color: number): string[] {
	const background = `\x1b[48;5;${Math.max(0, Math.min(255, Math.round(color)))}m`;

	return lines.map((line) =>
		line.includes(REVERSE_ON_MARKER) ? line.replace(REVERSE_ON, background).replace(REVERSE_OFF, "\x1b[49m") : line,
	);
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
