import assert from "node:assert/strict";
import { test } from "node:test";
import { type CopyOnSelectConfig, DEFAULT_CONFIG } from "../config.ts";
import { CopyOnSelectRuntime, type SessionLike, type TuiLike, type WidgetFactory } from "../runtime.ts";

const measure = (text: string): number => [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;

/** Minimal stand-in for a terminal-splitting editor that owns mouse reporting. */
class FakeCompositor {
	selection: { anchor: { row: number; col: number }; focus: { row: number; col: number } } | null = null;
	dragging = false;
	overlayVisible = false;
	leakedToEditor: string[] = [];
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	handleInput(data: string): boolean {
		if (this.overlayVisible) return false;

		const match = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data);
		if (!match) return false;

		const code = Number(match[1]);
		const point = { row: Number(match[3]), col: Number(match[2]) - 1 };
		const release = match[4] === "m";
		const button = code & ~(4 | 8 | 16 | 32);
		if (!release && (button === 64 || button === 65)) return true;

		if (release) {
			this.dragging = false;
			const selection = this.selection;
			if (selection && selection.anchor.row === selection.focus.row && selection.anchor.col === selection.focus.col) {
				this.selection = null;
			}
			return true;
		}

		if ((code & 32) !== 0) {
			if (this.dragging && this.selection) this.selection.focus = point;
			return true;
		}

		this.selection = { anchor: point, focus: point };
		this.dragging = true;
		return true;
	}
}

class FakeTui implements TuiLike {
	compositor: FakeCompositor;
	terminal: { rows: number; columns: number };
	renderRequests = 0;

	constructor(lines: string[], { ownsMouse = true }: { ownsMouse?: boolean } = {}) {
		this.compositor = new FakeCompositor(lines);
		this.terminal = { rows: 40, columns: 100 };
		if (ownsMouse) {
			Object.defineProperty(this.terminal, "rows", { configurable: true, get: () => 30 });
		}
	}

	handleInput(data: string): void {
		if (this.compositor.handleInput(data)) return;
		this.compositor.leakedToEditor.push(data);
	}

	render(_width: number): string[] {
		return [...this.compositor.lines];
	}

	requestRender(): void {
		this.renderRequests++;
	}

	hasOverlay(): boolean {
		return this.compositor.overlayVisible;
	}
}

class FakeSession implements SessionLike {
	cwd = "/project";
	mode = "tui";
	widgets = new Map<string, WidgetFactory | undefined>();
	notifications: string[] = [];

	ui = {
		setWidget: (key: string, content: WidgetFactory | undefined) => {
			if (content === undefined) {
				this.widgets.delete(key);
				return;
			}
			this.widgets.set(key, content);
		},
		notify: (message: string) => {
			this.notifications.push(message);
		},
		theme: { fg: (_color: string, text: string) => text },
	};
}

class Clock {
	private handle = 0;
	private timers = new Map<number, { callback: () => void; dueAt: number }>();
	now = 0;

	set = (callback: () => void, ms: number): unknown => {
		const id = ++this.handle;
		this.timers.set(id, { callback, dueAt: this.now + ms });
		return id;
	};

	clear = (handle: unknown): void => {
		this.timers.delete(handle as number);
	};

	advance(ms: number): void {
		this.now += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.dueAt <= this.now) {
				this.timers.delete(id);
				timer.callback();
			}
		}
	}

	get pending(): number {
		return this.timers.size;
	}
}

const VIEWPORT_WIDTH = 40;

interface Harness {
	runtime: CopyOnSelectRuntime;
	tui: FakeTui;
	session: FakeSession;
	clock: Clock;
	clipboard: string[];
	drag: (fromCol: number, fromRow: number, toCol: number, toRow: number) => void;
	frame: () => string[];
	toastRow: () => string | undefined;
}

function harness(overrides: Partial<CopyOnSelectConfig> = {}, options: { ownsMouse?: boolean; lines?: string[] } = {}): Harness {
	const lines = options.lines ?? ["first chat line", "second chat line", "third chat line"];
	const tui = new FakeTui(lines, { ownsMouse: options.ownsMouse });
	const session = new FakeSession();
	const clock = new Clock();
	const clipboard: string[] = [];

	const runtime = new CopyOnSelectRuntime({
		measure,
		copyToClipboard: async (text) => {
			clipboard.push(text);
		},
		readConfig: () => ({ ...DEFAULT_CONFIG, ...overrides }),
		setTimer: clock.set,
		clearTimer: clock.clear,
	});

	runtime.startSession(session);
	const capture = session.widgets.get("copy-on-select-capture");
	assert.ok(capture, "capture widget must be registered in tui mode");
	assert.deepEqual(capture(tui, session.ui.theme).render(10), [], "capture widget renders nothing");

	const frame = (): string[] => tui.render!(VIEWPORT_WIDTH);
	// Prime the render capture the way the TUI would before any mouse input.
	frame();

	const drag = (fromCol: number, fromRow: number, toCol: number, toRow: number): void => {
		tui.handleInput(`\x1b[<0;${fromCol};${fromRow}M`);
		tui.handleInput(`\x1b[<32;${toCol};${toRow}M`);
		tui.handleInput(`\x1b[<0;${toCol};${toRow}m`);
	};

	const toastRow = (): string | undefined => frame().find((line) => line.includes("Copied to clipboard"));

	return { runtime, tui, session, clock, clipboard, drag, frame, toastRow };
}

test("drag selection is copied, announced, and cleared immediately by default", () => {
	const h = harness();

	h.drag(1, 1, 6, 1);

	assert.deepEqual(h.clipboard, ["first"], "selection text is copied once");
	assert.equal(h.tui.compositor.selection, null, "highlight is cleared right away");
	assert.deepEqual(h.tui.compositor.leakedToEditor, [], "no synthetic input reaches the editor");

	const toast = h.toastRow();
	assert.ok(toast, "toast is painted into the frame");
	assert.match(toast, /✓ Copied to clipboard$/, "toast sits at the right edge");
	assert.equal(measure(toast), VIEWPORT_WIDTH - 1, "one column stays free at the right edge");
	assert.equal(h.frame().length, 3, "no extra row is added, so nothing shifts");

	h.clock.advance(DEFAULT_CONFIG.toastMs);
	assert.equal(h.toastRow(), undefined, "toast disappears on its own");
	assert.ok(h.tui.renderRequests >= 2, "showing and hiding the toast request renders");
});

test("multi-row selection keeps line breaks", () => {
	const h = harness();

	h.drag(7, 1, 7, 3);

	assert.deepEqual(h.clipboard, ["chat line\nsecond chat line\nthird"]);
});

test("delayed mode leaves the highlight up for the configured time", () => {
	const h = harness({ clearSelection: "delayed", delayMs: 300 });

	h.drag(1, 2, 7, 2);
	assert.ok(h.tui.compositor.selection, "highlight survives the delay");

	h.clock.advance(300);
	assert.equal(h.tui.compositor.selection, null, "highlight is dropped after the delay");
});

test("delayed mode with a zero delay behaves like immediate", () => {
	const h = harness({ clearSelection: "delayed", delayMs: 0 });

	h.drag(1, 2, 7, 2);

	assert.equal(h.tui.compositor.selection, null);
});

test("keep mode leaves the highlight for manual copying", () => {
	const h = harness({ clearSelection: "keep" });

	h.drag(1, 2, 7, 2);
	h.clock.advance(10_000);

	assert.deepEqual(h.clipboard, ["second"]);
	assert.ok(h.tui.compositor.selection, "highlight stays until the user clears it");
});

test("toast can be disabled while copying stays on", () => {
	const h = harness({ toast: false });

	h.drag(1, 1, 6, 1);

	assert.deepEqual(h.clipboard, ["first"]);
	assert.equal(h.toastRow(), undefined);
	assert.deepEqual(h.frame(), h.tui.compositor.lines, "frame is untouched");
});

test("copy can be disabled while the highlight still clears", () => {
	const h = harness({ copy: false });

	h.drag(1, 1, 6, 1);

	assert.deepEqual(h.clipboard, []);
	assert.equal(h.tui.compositor.selection, null);
	assert.ok(h.toastRow());
});

test("disabled config leaves mouse handling and the frame untouched", () => {
	const h = harness({ enabled: false });

	h.drag(1, 1, 6, 1);
	h.clock.advance(10_000);

	assert.deepEqual(h.clipboard, []);
	assert.ok(h.tui.compositor.selection, "highlight is left alone when disabled");
	assert.equal(h.toastRow(), undefined);
});

test("plain clicks and wheel scrolling copy nothing", () => {
	const h = harness();

	h.tui.handleInput("\x1b[<0;4;2M");
	h.tui.handleInput("\x1b[<0;4;2m");
	h.tui.handleInput("\x1b[<64;4;2M");

	assert.deepEqual(h.clipboard, []);
	assert.equal(h.toastRow(), undefined);
});

test("nothing happens without an editor that owns mouse reporting", () => {
	const h = harness({}, { ownsMouse: false });

	h.drag(1, 1, 6, 1);
	h.clock.advance(10_000);

	assert.deepEqual(h.clipboard, []);
	assert.ok(h.tui.compositor.selection, "selection is left to the terminal or other extensions");
});

test("visible overlays suspend selection handling", () => {
	const h = harness();
	h.tui.compositor.overlayVisible = true;

	h.drag(1, 1, 6, 1);

	assert.deepEqual(h.clipboard, []);
	assert.equal(h.tui.compositor.leakedToEditor.length, 3, "overlay owns the input, extension stays out of the way");
});

test("selection is dropped when the viewport changes mid-drag", () => {
	const h = harness();

	h.tui.handleInput("\x1b[<0;1;1M");
	h.tui.compositor.lines = ["scrolled line", "second chat line", "third chat line"];
	h.frame();
	h.tui.handleInput("\x1b[<32;6;1M");
	h.tui.handleInput("\x1b[<0;6;1m");

	assert.deepEqual(h.clipboard, [], "stale text is never copied");
});

test("installing twice does not double-handle input", () => {
	const h = harness();
	h.runtime.install(h.tui);

	h.drag(1, 1, 6, 1);

	assert.deepEqual(h.clipboard, ["first"]);
});

test("command toggles behavior and reports status", () => {
	const h = harness();

	assert.match(h.runtime.handleCommand("", h.session).message, /copy-on-select on/);

	assert.equal(h.runtime.handleCommand("off", h.session).level, "info");
	assert.equal(h.runtime.getConfig().enabled, false);
	h.drag(1, 1, 6, 1);
	assert.deepEqual(h.clipboard, [], "disabled runtime ignores selections");

	h.runtime.handleCommand("on", h.session);
	h.runtime.handleCommand("clear keep", h.session);
	h.runtime.handleCommand("toast off", h.session);
	assert.equal(h.runtime.getConfig().clearSelection, "keep");
	assert.equal(h.runtime.getConfig().toast, false);

	h.drag(1, 1, 6, 1);
	assert.deepEqual(h.clipboard, ["first"]);
	assert.equal(h.toastRow(), undefined);

	const unknown = h.runtime.handleCommand("sideways", h.session);
	assert.equal(unknown.level, "warning");
	assert.match(unknown.message, /Unknown argument/);

	h.runtime.handleCommand("reload", h.session);
	assert.deepEqual(h.runtime.getConfig(), DEFAULT_CONFIG, "reload restores settings from disk");
});

test("turning the toast off hides one that is already showing", () => {
	const h = harness();

	h.drag(1, 1, 6, 1);
	assert.ok(h.toastRow());

	h.runtime.handleCommand("toast off", h.session);

	assert.equal(h.toastRow(), undefined);
	assert.equal(h.clock.pending, 0, "toast timer is cancelled");
});

test("command warns when no editor owns mouse selection", () => {
	const h = harness({}, { ownsMouse: false });

	const result = h.runtime.handleCommand("", h.session);

	assert.equal(result.level, "warning");
	assert.match(result.message, /inactive: no editor owns mouse selection/);
});

test("session shutdown clears timers and the toast", () => {
	const h = harness({ clearSelection: "delayed", delayMs: 300 });

	h.drag(1, 1, 6, 1);
	h.runtime.stopSession();

	assert.equal(h.clock.pending, 0);
	assert.equal(h.toastRow(), undefined);
});

test("non-tui sessions register no widgets", () => {
	const session = new FakeSession();
	session.mode = "print";
	const runtime = new CopyOnSelectRuntime({
		measure,
		copyToClipboard: async () => {},
		readConfig: () => ({ ...DEFAULT_CONFIG }),
	});

	runtime.startSession(session);

	assert.equal(session.widgets.size, 0);
});
