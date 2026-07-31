/**
 * Bottom-right toast rendering.
 *
 * The toast is a below-editor widget rather than a TUI overlay: visible overlays
 * make terminal-splitting editors (for example pi-powerline-footer's fixed
 * editor) release mouse ownership, which would break selection and scrolling
 * while the toast is on screen.
 */

export interface ToastStyle {
	icon: (text: string) => string;
	text: (text: string) => string;
}

export interface ToastMetrics {
	measure: (text: string) => number;
	truncate: (text: string, width: number) => string;
}

const MIN_TOAST_WIDTH = 6;

/** Renders a single right-aligned toast line that fits `width` columns. */
export function renderToastLine(message: string, width: number, style: ToastStyle, metrics: ToastMetrics): string[] {
	if (width < MIN_TOAST_WIDTH || message.trim().length === 0) return [];

	const plain = ` ✓ ${message} `;
	const visible = metrics.measure(plain);
	if (visible > width) {
		return [style.text(metrics.truncate(plain, width))];
	}

	const padding = " ".repeat(width - visible);
	return [`${padding} ${style.icon("✓")} ${style.text(message)} `];
}
