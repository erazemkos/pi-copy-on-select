/**
 * Extension runtime: selection capture, clipboard handling, toast lifecycle, and
 * highlight clearing.
 *
 * All pi-specific imports are injected so this module can be exercised without a
 * terminal or a pi installation; `index.ts` wires in the real implementations.
 */

import { type ClearSelectionMode, type CopyOnSelectConfig, DEFAULT_CONFIG, describeConfig } from "./config.ts";
import { applyFade, fadeStepMs } from "./fade.ts";
import { parseSgrMousePackets, SelectionTracker } from "./selection.ts";
import { compositeLineFallback, paintToast } from "./toast.ts";

const CAPTURE_WIDGET_KEY = "copy-on-select-capture";
/**
 * Hooks are stored on the TUI under a global symbol. `/reload` re-imports this
 * module, so a module-local symbol or flag would leave the previous (now stale)
 * runtime owning the hooks while the fresh one sits idle with the new config.
 */
const HOOKS_KEY = Symbol.for("pi-copy-on-select.hooks");
/** Marker used by pre-0.3 releases, whose hooks cannot be handed over. */
const LEGACY_FLAG = "__piCopyOnSelectInstalled";
/** Column 2 keeps the synthetic click inside the content area for any output padding. */
const SYNTHETIC_CLICK_COL = 2;
/** Row 1 is always inside the scrollable chat viewport. */
const SYNTHETIC_CLICK_ROW = 1;

export interface TerminalLike {
	rows?: number;
	columns?: number;
}

export interface TuiLike {
	/** Public TUI input-listener API used by current pi releases. */
	addInputListener?(listener: (data: string) => void): () => void;
	/** Legacy private dispatcher retained as a fallback for older pi releases. */
	handleInput?(data: string): void;
	render?(width: number): string[];
	requestRender?(): void;
	hasOverlay?(): boolean;
	compositeLineAt?(baseLine: string, overlayLine: string, startCol: number, overlayWidth: number, totalWidth: number): string;
	terminal?: TerminalLike;
}

interface TuiHooks {
	/** Runtime currently responsible for handling hook callbacks. */
	owner: CopyOnSelectRuntime;
	originalHandleInput: (data: string) => void;
	renderWrapper: ((width: number) => string[]) | null;
	replaying: boolean;
	/**
	 * Last rendered viewport. Lives on the hooks rather than the runtime so a
	 * reloaded instance can read selections before the next frame is drawn.
	 */
	frame: readonly string[];
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
	private hooks: TuiHooks | null = null;
	private toastLabel: string | null = null;
	/** Index into `config.fadeColors` while a fade is running, else null. */
	private fadeStep: number | null = null;
	private pendingClear: unknown = null;
	private pendingToast: unknown = null;
	private pendingFade: unknown = null;

	constructor(deps: RuntimeDeps) {
		this.deps = deps;
		this.tracker = new SelectionTracker({ measure: deps.measure });
		this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	getConfig(): CopyOnSelectConfig {
		return { ...this.config };
	}

	/** True while this runtime owns the TUI hooks. */
	isActive(): boolean {
		return this.hooks !== null && this.hooks.owner === this;
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
		this.clearToast();
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
				this.clearToast();
				this.tracker.reset();
			}
		} else if (command === "toast on" || command === "toast off") {
			this.config = { ...this.config, toast: command === "toast on" };
			if (!this.config.toast) this.clearToast();
		} else if (
			command === "clear immediate"
			|| command === "clear fade"
			|| command === "clear delayed"
			|| command === "clear keep"
		) {
			this.config = { ...this.config, clearSelection: command.slice("clear ".length) as ClearSelectionMode };
		} else if (command === "reload") {
			this.config = this.deps.readConfig(session.cwd);
		} else if (command === "status" || command === "debug") {
			return { message: this.describeState(), level: "info" };
		} else if (command.length > 0) {
			return {
				message: `Unknown argument: ${command}. Use on|off|toast on|toast off|clear immediate|clear fade|clear delayed|clear keep|reload|status`,
				level: "warning",
			};
		}

		if (this.tui && !ownsMouseReporting(this.tui)) {
			return { message: `${describeConfig(this.config)} — inactive: no editor owns mouse selection`, level: "warning" };
		}

		return { message: describeConfig(this.config), level: "info" };
	}

	/** Diagnostics for `/copy-on-select status`. */
	describeState(): string {
		const tui = this.tui;
		const legacy = tui !== null && (tui as TuiLike & { [LEGACY_FLAG]?: boolean })[LEGACY_FLAG] === true;
		const parts = [
			describeConfig(this.config),
			`hooks ${this.isActive() ? "owned" : this.hooks ? "handed over" : "missing"}`,
			...(legacy ? ["pre-0.3 hooks still attached, restart pi"] : []),
			`mouse ${tui && ownsMouseReporting(tui) ? "owned by editor" : "not captured"}`,
			`frame ${this.hooks?.frame.length ?? 0} rows`,
			`toast ${this.toastLabel === null ? "idle" : "showing"}`,
			`fade ${this.fadeStep === null ? "idle" : `step ${this.fadeStep + 1}/${this.config.fadeColors.length}`}`,
		];

		return parts.join(" · ");
	}

	/**
	 * Installs (or takes over) the TUI hooks. Safe to call repeatedly, including
	 * after `/reload`, when a fresh runtime must replace the previous owner.
	 */
	install(tui: TuiLike): void {
		this.tui = tui;

		const store = tui as TuiLike & { [HOOKS_KEY]?: TuiHooks };
		const existing = store[HOOKS_KEY];
		if (existing) {
			if (existing.owner !== this) {
				existing.owner.handOver();
				existing.owner = this;
			}
			this.hooks = existing;
			this.assertRenderHook(tui, existing);
			return;
		}

		const legacyHandleInput = typeof tui.handleInput === "function" ? tui.handleInput.bind(tui) : null;
		// Current pi calls this private dispatcher `handleTerminalInput`. Wrapping it
		// observes mouse packets before pi's built-in viewport listener consumes them
		// and also provides the synthetic-click replay path.
		const currentHandleInput = Reflect.get(tui as object, "handleTerminalInput");
		const inputDispatcher = typeof currentHandleInput === "function"
			? currentHandleInput.bind(tui) as (data: string) => void
			: legacyHandleInput;

		const hooks: TuiHooks = {
			owner: this,
			originalHandleInput: inputDispatcher ?? (() => {}),
			renderWrapper: null,
			replaying: false,
			frame: [],
		};
		store[HOOKS_KEY] = hooks;
		this.hooks = hooks;

		const wrapInput = (data: string): void => {
			if (hooks.replaying) {
				hooks.originalHandleInput(data);
				return;
			}
			const copied = hooks.owner.onInput(tui, hooks, data);
			hooks.originalHandleInput(data);
			if (copied !== null) hooks.owner.onSelectionCopied(copied, tui, hooks);
		};

		if (typeof currentHandleInput === "function") {
			// Wrap before pi's built-in viewport listener can consume mouse packets.
			Reflect.set(tui as object, "handleTerminalInput", wrapInput);
		} else if (typeof tui.addInputListener === "function") {
			// Supported path for releases whose public listeners receive raw mouse input.
			tui.addInputListener((data: string): void => {
				if (hooks.replaying) return;
				const copied = hooks.owner.onInput(tui, hooks, data);
				if (copied !== null) hooks.owner.onSelectionCopied(copied, tui, hooks);
			});
		} else if (legacyHandleInput) {
			tui.handleInput = wrapInput;
		}

		this.assertRenderHook(tui, hooks);
	}

	/** Called on the outgoing runtime when a newer one takes over the hooks. */
	private handOver(): void {
		this.cancelTimers();
		this.toastLabel = null;
		this.fadeStep = null;
		this.hooks = null;
		this.session = null;
	}

	/**
	 * Re-asserts the render hook as the outermost wrapper. The surrounding editor
	 * tears its own render hook down and rebuilds it (first keypress, `/powerline`
	 * commands, resizes), which drops ours, so this runs on every input.
	 */
	private assertRenderHook(tui: TuiLike, hooks: TuiHooks): void {
		const currentRender = tui.render;
		if (typeof currentRender !== "function" || currentRender === hooks.renderWrapper) return;

		const originalRender = currentRender.bind(tui);
		hooks.renderWrapper = (width: number): string[] => hooks.owner.onFrame(tui, hooks, originalRender(width), width);
		tui.render = hooks.renderWrapper;
	}

	/** Observes one raw input chunk before the TUI dispatches it. */
	private onInput(tui: TuiLike, hooks: TuiHooks, data: string): string | null {
		this.assertRenderHook(tui, hooks);

		const active = this.config.enabled && ownsMouseReporting(tui) && !hasVisibleOverlay(tui);
		if (!active) this.tracker.reset();

		let copied: string | null = null;
		if (active) {
			for (const packet of parseSgrMousePackets(data)) {
				copied = this.tracker.handlePacket(packet, hooks.frame) ?? copied;
			}
		}

		return copied;
	}

	/**
	 * Records the rendered viewport (used to read selected text) and paints the
	 * toast into the bottom-right corner of the same frame.
	 */
	private onFrame(tui: TuiLike, hooks: TuiHooks, lines: string[], width: number): string[] {
		hooks.frame = lines;

		let painted = lines;

		// Repaint the reverse-video selection as a dimming background while fading.
		const fadeStep = this.fadeStep;
		if (fadeStep !== null) {
			const color = this.config.fadeColors[Math.min(fadeStep, this.config.fadeColors.length - 1)];
			if (color !== undefined) painted = applyFade(painted, color);
		}

		const label = this.toastLabel;
		if (label !== null) {
			const composite = tui.compositeLineAt?.bind(tui) ?? compositeLineFallback;
			painted = paintToast(painted, width, { label, measure: this.deps.measure, composite });
		}

		return painted;
	}

	private onSelectionCopied(text: string, tui: TuiLike, hooks: TuiHooks): void {
		if (this.config.copy) {
			void this.deps.copyToClipboard(text).catch(() => {
				/* Clipboard tooling can be unavailable; the highlight still clears. */
			});
		}
		if (this.config.toast) this.showToast(tui);
		this.scheduleClear(tui, hooks);
	}

	private scheduleClear(tui: TuiLike, hooks: TuiHooks): void {
		this.cancelClearTimers();

		const mode = this.config.clearSelection;
		if (mode === "keep") return;

		if (mode === "fade") {
			if (this.config.fadeColors.length > 0) {
				this.startFade(tui, hooks);
			} else {
				this.clearHighlight(tui, hooks);
			}
			return;
		}

		if (mode === "immediate" || this.config.delayMs === 0) {
			this.clearHighlight(tui, hooks);
			return;
		}

		this.pendingClear = this.setTimer(() => {
			this.pendingClear = null;
			this.clearHighlight(tui, hooks);
		}, this.config.delayMs);
	}

	/** Steps the selection down the colour ramp, then drops it. */
	private startFade(tui: TuiLike, hooks: TuiHooks): void {
		const colors = this.config.fadeColors;
		const stepMs = fadeStepMs(this.config.fadeMs, colors.length);

		this.fadeStep = 0;
		tui.requestRender?.();

		const advance = (): void => {
			const next = (this.fadeStep ?? 0) + 1;
			if (next >= colors.length) {
				this.pendingFade = null;
				this.fadeStep = null;
				this.clearHighlight(tui, hooks);
				tui.requestRender?.();
				return;
			}

			this.fadeStep = next;
			tui.requestRender?.();
			this.pendingFade = this.setTimer(advance, stepMs);
		};

		this.pendingFade = this.setTimer(advance, stepMs);
	}

	/** Replays a zero-width click so the editor that owns the highlight drops it. */
	private clearHighlight(tui: TuiLike, hooks: TuiHooks): void {
		this.fadeStep = null;
		if (!ownsMouseReporting(tui) || hasVisibleOverlay(tui)) return;

		hooks.replaying = true;
		try {
			hooks.originalHandleInput(`\x1b[<0;${SYNTHETIC_CLICK_COL};${SYNTHETIC_CLICK_ROW}M`);
			hooks.originalHandleInput(`\x1b[<0;${SYNTHETIC_CLICK_COL};${SYNTHETIC_CLICK_ROW}m`);
		} finally {
			hooks.replaying = false;
		}
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
			this.clearToast();
		}, this.config.toastMs);
	}

	private clearToast(): void {
		if (this.pendingToast) this.clearTimer(this.pendingToast);
		this.pendingToast = null;
		if (this.toastLabel === null) return;

		this.toastLabel = null;
		this.tui?.requestRender?.();
	}

	private cancelClearTimers(): void {
		if (this.pendingClear) this.clearTimer(this.pendingClear);
		if (this.pendingFade) this.clearTimer(this.pendingFade);
		this.pendingClear = null;
		this.pendingFade = null;
	}

	private cancelTimers(): void {
		this.cancelClearTimers();
		if (this.pendingToast) this.clearTimer(this.pendingToast);
		this.pendingToast = null;
	}
}
