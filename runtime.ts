/**
 * Extension runtime: selection capture, clipboard handling, toast lifecycle, and
 * highlight clearing.
 *
 * All pi-specific imports are injected so this module can be exercised without a
 * terminal or a pi installation; `index.ts` wires in the real implementations.
 */

import { type ClearSelectionMode, type CopyOnSelectConfig, DEFAULT_CONFIG, describeConfig } from "./config.ts";
import { parseSgrMousePackets, SelectionTracker } from "./selection.ts";
import { compositeLineFallback, paintToast } from "./toast.ts";

const CAPTURE_WIDGET_KEY = "copy-on-select-capture";
const INSTALL_FLAG = "__piCopyOnSelectInstalled";
/** Column 2 keeps the synthetic click inside the content area for any output padding. */
const SYNTHETIC_CLICK_COL = 2;
/** Row 1 is always inside the scrollable chat viewport. */
const SYNTHETIC_CLICK_ROW = 1;

export interface TerminalLike {
	rows?: number;
	columns?: number;
}

export interface TuiLike {
	handleInput(data: string): void;
	render?(width: number): string[];
	requestRender?(): void;
	hasOverlay?(): boolean;
	compositeLineAt?(baseLine: string, overlayLine: string, startCol: number, overlayWidth: number, totalWidth: number): string;
	terminal?: TerminalLike;
}

export interface WidgetComponent {
	render(width: number): string[];
	invalidate(): void;
}

export interface ThemeLike {
	fg(color: string, text: string): string;
}

export type WidgetFactory = (tui: unknown, theme: ThemeLike) => WidgetComponent;

export interface SessionUi {
	setWidget(key: string, content: WidgetFactory | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	readonly theme?: ThemeLike;
}

export interface SessionLike {
	cwd: string;
	mode: string;
	ui: SessionUi;
}

export interface RuntimeDeps {
	/** Visible width of a string, ignoring ANSI escapes. */
	measure: (text: string) => number;
	copyToClipboard: (text: string) => Promise<void>;
	readConfig: (cwd: string) => CopyOnSelectConfig;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

/**
 * A terminal-splitting editor takes mouse ownership by redefining `rows` as an own
 * accessor on the terminal. Without it nothing renders selections, and replaying
 * clicks could leak raw mouse reports into the editor.
 */
export function ownsMouseReporting(tui: TuiLike): boolean {
	const terminal = tui.terminal;
	if (!terminal) return false;

	return typeof Object.getOwnPropertyDescriptor(terminal, "rows")?.get === "function";
}

function hasVisibleOverlay(tui: TuiLike): boolean {
	return typeof tui.hasOverlay === "function" && tui.hasOverlay();
}

export class CopyOnSelectRuntime {
	private readonly deps: RuntimeDeps;
	private readonly tracker: SelectionTracker;
	private readonly setTimer: (callback: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	private config: CopyOnSelectConfig = { ...DEFAULT_CONFIG };
	private session: SessionLike | null = null;
	private tui: TuiLike | null = null;
	private viewportLines: readonly string[] = [];
	private renderWrapper: ((width: number) => string[]) | null = null;
	private toastLabel: string | null = null;
	private pendingClear: unknown = null;
	private pendingToast: unknown = null;

	constructor(deps: RuntimeDeps) {
		this.deps = deps;
		this.tracker = new SelectionTracker({ measure: deps.measure });
		this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	getConfig(): CopyOnSelectConfig {
		return { ...this.config };
	}

	/** Called on `session_start`: refreshes config and installs the capture widget. */
	startSession(session: SessionLike): void {
		this.session = session;
		this.config = this.deps.readConfig(session.cwd);
		this.tracker.reset();

		if (session.mode !== "tui") return;

		// The widget renders nothing; it is the supported way to obtain the TUI instance.
		session.ui.setWidget(CAPTURE_WIDGET_KEY, (tui) => {
			this.install(tui as TuiLike);
			return { render: () => [], invalidate: () => {} };
		});
	}

	/** Called on `session_shutdown`: drops timers and UI owned by this session. */
	stopSession(): void {
		this.cancelTimers();
		this.hideToast();
		this.tracker.reset();
		this.session = null;
	}

	/** Handles `/copy-on-select` arguments. Returns the message to show the user. */
	handleCommand(args: string, session: SessionLike): { message: string; level: "info" | "warning" } {
		this.session = session;
		const command = args.trim().toLowerCase();

		if (command === "on" || command === "off") {
			this.config = { ...this.config, enabled: command === "on" };
			if (!this.config.enabled) {
				this.cancelTimers();
				this.hideToast();
				this.tracker.reset();
			}
		} else if (command === "toast on" || command === "toast off") {
			this.config = { ...this.config, toast: command === "toast on" };
			if (!this.config.toast) this.hideToast();
		} else if (command === "clear immediate" || command === "clear delayed" || command === "clear keep") {
			this.config = { ...this.config, clearSelection: command.slice("clear ".length) as ClearSelectionMode };
		} else if (command === "reload") {
			this.config = this.deps.readConfig(session.cwd);
		} else if (command.length > 0) {
			return {
				message: `Unknown argument: ${command}. Use on|off|toast on|toast off|clear immediate|clear delayed|clear keep|reload`,
				level: "warning",
			};
		}

		if (this.tui && !ownsMouseReporting(this.tui)) {
			return { message: `${describeConfig(this.config)} — inactive: no editor owns mouse selection`, level: "warning" };
		}

		return { message: describeConfig(this.config), level: "info" };
	}

	/** Wraps TUI input and rendering. Safe to call repeatedly for the same TUI. */
	install(tui: TuiLike): void {
		const flagged = tui as TuiLike & { [INSTALL_FLAG]?: boolean };
		this.tui = tui;
		if (flagged[INSTALL_FLAG]) return;
		flagged[INSTALL_FLAG] = true;

		const originalHandleInput = tui.handleInput.bind(tui);
		let replaying = false;

		const replay = (data: string): void => {
			replaying = true;
			try {
				originalHandleInput(data);
			} finally {
				replaying = false;
			}
		};

		this.wrapRender(tui);

		tui.handleInput = (data: string): void => {
			if (replaying) {
				originalHandleInput(data);
				return;
			}

			// The editor that owns the viewport may reinstall its own render hook.
			this.wrapRender(tui);

			const active = this.config.enabled && ownsMouseReporting(tui) && !hasVisibleOverlay(tui);
			if (!active) this.tracker.reset();

			let copied: string | null = null;
			if (active) {
				for (const packet of parseSgrMousePackets(data)) {
					copied = this.tracker.handlePacket(packet, this.viewportLines) ?? copied;
				}
			}

			originalHandleInput(data);

			if (copied !== null) this.onSelectionCopied(copied, tui, replay);
		};
	}

	/**
	 * Captures what the viewport currently shows (for selection text) and paints the
	 * toast into the bottom-right corner of the same frame.
	 */
	private wrapRender(tui: TuiLike): void {
		const currentRender = tui.render;
		if (typeof currentRender !== "function" || currentRender === this.renderWrapper) return;

		const originalRender = currentRender.bind(tui);
		this.renderWrapper = (width: number): string[] => {
			const lines = originalRender(width);
			this.viewportLines = lines;

			const label = this.toastLabel;
			if (label === null) return lines;

			const composite = tui.compositeLineAt?.bind(tui) ?? compositeLineFallback;
			return paintToast(lines, width, { label, measure: this.deps.measure, composite });
		};
		tui.render = this.renderWrapper;
	}

	private onSelectionCopied(text: string, tui: TuiLike, replay: (data: string) => void): void {
		if (this.config.copy) {
			void this.deps.copyToClipboard(text).catch(() => {
				/* Clipboard tooling can be unavailable; the highlight still clears. */
			});
		}
		if (this.config.toast) this.showToast(tui);
		this.scheduleClear(() => this.clearHighlight(tui, replay));
	}

	private scheduleClear(run: () => void): void {
		if (this.pendingClear) this.clearTimer(this.pendingClear);
		this.pendingClear = null;

		if (this.config.clearSelection === "keep") return;
		if (this.config.clearSelection === "immediate" || this.config.delayMs === 0) {
			run();
			return;
		}

		this.pendingClear = this.setTimer(() => {
			this.pendingClear = null;
			run();
		}, this.config.delayMs);
	}

	/** Replays a zero-width click so the editor that owns the highlight drops it. */
	private clearHighlight(tui: TuiLike, replay: (data: string) => void): void {
		if (!ownsMouseReporting(tui) || hasVisibleOverlay(tui)) return;

		replay(`\x1b[<0;${SYNTHETIC_CLICK_COL};${SYNTHETIC_CLICK_ROW}M`);
		replay(`\x1b[<0;${SYNTHETIC_CLICK_COL};${SYNTHETIC_CLICK_ROW}m`);
	}

	private showToast(tui: TuiLike): void {
		if (this.pendingToast) this.clearTimer(this.pendingToast);

		const theme = this.session?.ui.theme;
		const icon = theme ? theme.fg("success", "✓") : "✓";
		const text = theme ? theme.fg("muted", this.config.toastText) : this.config.toastText;
		this.toastLabel = `${icon} ${text}`;
		tui.requestRender?.();

		this.pendingToast = this.setTimer(() => {
			this.pendingToast = null;
			this.hideToast();
		}, this.config.toastMs);
	}

	private hideToast(): void {
		if (this.pendingToast) this.clearTimer(this.pendingToast);
		this.pendingToast = null;
		if (this.toastLabel === null) return;

		this.toastLabel = null;
		this.tui?.requestRender?.();
	}

	private cancelTimers(): void {
		if (this.pendingClear) this.clearTimer(this.pendingClear);
		if (this.pendingToast) this.clearTimer(this.pendingToast);
		this.pendingClear = null;
		this.pendingToast = null;
	}
}
