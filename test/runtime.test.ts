import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type CopyOnSelectConfig } from "../config.ts";
import { CopyOnSelectRuntime, type SessionLike, type TuiLike, type WidgetFactory } from "../runtime.ts";

const measure = (text: string): number => [...text].length;
const truncate = (text: string, width: number): string => [...text].slice(0, width).join("");

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
	renderCalls = 0;

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
		this.renderCalls++;
		return this.compositor.lines;
	}

	hasOverlay(): boolean {
		return this.compositor.overlayVisible;
	}
}

interface WidgetRecord {
	factory: WidgetFactory | undefined;
	placement?: string;
}

class FakeSession implements SessionLike {
	cwd = "/project";
	mode = "tui";
	widgets = new Map<string, WidgetRecord>();
	notifications: string[] = [];

	ui = {
		setWidget: (key: string, content: WidgetFactory | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => {
			if (content === undefined) {
				this.widgets.delete(key);
				return;
			}
			this.widgets.set(key, { factory: content, placement: options?.placement });
		},
		notify: (message: string) => {
			this.notifications.push(message);
		},
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

interface Harness {
	runtime: CopyOnSelectRuntime;
	tui: FakeTui;
	session: FakeSession;
	clock: Clock;
	clipboard: string[];
	drag: (fromCol: number, fromRow: number, toCol: number, toRow: number) => void;
	toastLines: () => string[];
}

function harness(overrides: Partial<CopyOnSelectConfig> = {}, options: { ownsMouse?: boolean; lines?: string[] } = {}): Harness {
	const lines = options.lines ?? ["first chat line", "second chat line", "third chat line"];
	const tui = new FakeTui(lines, { ownsMouse: options.ownsMouse });
	const session = new FakeSession();
	const clock = new Clock();
	const clipboard: string[] = [];

	const runtime = new CopyOnSelectRuntime({
		measure,
		truncate,
		copyToClipboard: async (text) => {
			clipboard.push(text);
		},
		readConfig: () => ({ ...DEFAULT_CONFIG, ...overrides }),
		setTimer: clock.set,
		clearTimer: clock.clear,
	});

	runtime.startSession(session);
	const capture = session.widgets.get("copy-on-select-capture");
	assert.ok(capture?.factory, "capture widget must be registered in tui mode");
	assert.deepEqual(capture.factory(tui, { fg: (_color, text) => text }).render(10), [], "capture widget renders nothing");

	// Prime the render capture the way the TUI would before any mouse input.
	tui.render(80);

	const drag = (fromCol: number, fromRow: number, toCol: number, toRow: number): void => {
		tui.handleInput(`\x1b[<0;${fromCol};${fromRow}M`);
		tui.handleInput(`\x1b[<32;${toCol};${toRow}M`);
		tui.handleInput(`\x1b[<0;${toCol};${toRow}m`);
	};

	const toastLines = (): string[] => {
		const toast = session.widgets.get("copy-on-select-toast");
		if (!toast?.factory) return [];
		return toast.factory(tui, { fg: (_color, text) => text }).render(40);
	};

	return { runtime, tui, session, clock, clipboard, drag, toastLines };
}

test("drag selection is copied, announced, and cleared after the fade delay", () => {
	const h = harness();

	h.drag(1, 1, 6, 1);

	assert.deepEqual(h.clipboard, ["first"], "selection text is copied once");
	assert.equal(h.session.widgets.get("copy-on-select-toast")?.placement, "belowEditor");
	assert.match(h.toastLines()[0] ?? "", /✓ Copied to clipboard $/);
	assert.ok(h.tui.compositor.selection, "highlight survives the fade delay");

	h.clock.advance(DEFAULT_CONFIG.fadeMs);
	assert.equal(h.tui.compositor.selection, null, "highlight is cleared by the replayed click");
	assert.deepEqual(h.tui.compositor.leakedToEditor, [], "no synthetic input reaches the editor");

	h.clock.advance(DEFAULT_CONFIG.toastMs);
	assert.deepEqual(h.toastLines(), [], "toast disappears on its own");
});

test("multi-row selection keeps line breaks", () => {
	const h = harness();

	h.drag(7, 1, 7, 3);

	assert.deepEqual(h.clipboard, ["chat line\nsecond chat line\nthird"]);
});

test("clear immediate drops the highlight without waiting", () => {
	const h = harness({ clearSelection: "immediate" });

	h.drag(1, 2, 7, 2);

	assert.equal(h.tui.compositor.selection, null);
	assert.equal(h.clock.pending, 1, "only the toast timer remains");
});

test("clear off keeps the highlight for manual copying", () => {
	const h = harness({ clearSelection: "off" });

	h.drag(1, 2, 7, 2);
	h.clock.advance(10_000);

	assert.deepEqual(h.clipboard, ["second"]);
	assert.ok(h.tui.compositor.selection, "highlight stays until the user clears it");
});

test("toast can be disabled while copying stays on", () => {
	const h = harness({ toast: false });

	h.drag(1, 1, 6, 1);

	assert.deepEqual(h.clipboard, ["first"]);
	assert.deepEqual(h.toastLines(), []);
});

test("copy can be disabled while the highlight still clears", () => {
	const h = harness({ copy: false, clearSelection: "immediate" });

	h.drag(1, 1, 6, 1);

	assert.deepEqual(h.clipboard, []);
	assert.equal(h.tui.compositor.selection, null);
	assert.match(h.toastLines()[0] ?? "", /Copied to clipboard/);
});

test("disabled config leaves mouse handling untouched", () => {
	const h = harness({ enabled: false });

	h.drag(1, 1, 6, 1);
	h.clock.advance(10_000);

	assert.deepEqual(h.clipboard, []);
	assert.ok(h.tui.compositor.selection, "highlight is left alone when disabled");
	assert.deepEqual(h.toastLines(), []);
});

test("plain clicks and wheel scrolling copy nothing", () => {
	const h = harness();

	h.tui.handleInput("\x1b[<0;4;2M");
	h.tui.handleInput("\x1b[<0;4;2m");
	h.tui.handleInput("\x1b[<64;4;2M");

	assert.deepEqual(h.clipboard, []);
	assert.deepEqual(h.toastLines(), []);
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
	assert.deepEqual(h.tui.compositor.leakedToEditor.length, 3, "overlay owns the input, extension stays out of the way");
});

test("selection is dropped when the viewport changes mid-drag", () => {
	const h = harness();

	h.tui.handleInput("\x1b[<0;1;1M");
	h.tui.compositor.lines = ["scrolled line", "second chat line", "third chat line"];
	h.tui.render(80);
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
	h.runtime.handleCommand("clear off", h.session);
	h.runtime.handleCommand("toast off", h.session);
	assert.deepEqual(h.runtime.getConfig().clearSelection, "off");
	assert.equal(h.runtime.getConfig().toast, false);

	h.drag(1, 1, 6, 1);
	assert.deepEqual(h.clipboard, ["first"]);
	assert.deepEqual(h.toastLines(), []);

	const unknown = h.runtime.handleCommand("sideways", h.session);
	assert.equal(unknown.level, "warning");
	assert.match(unknown.message, /Unknown argument/);

	h.runtime.handleCommand("reload", h.session);
	assert.deepEqual(h.runtime.getConfig(), DEFAULT_CONFIG, "reload restores settings from disk");
});

test("command warns when no editor owns mouse selection", () => {
	const h = harness({}, { ownsMouse: false });

	const result = h.runtime.handleCommand("", h.session);

	assert.equal(result.level, "warning");
	assert.match(result.message, /inactive: no editor owns mouse selection/);
});

test("session shutdown clears timers and the toast", () => {
	const h = harness();

	h.drag(1, 1, 6, 1);
	h.runtime.stopSession();

	assert.equal(h.clock.pending, 0);
	assert.deepEqual(h.toastLines(), []);
});

test("non-tui sessions register no widgets", () => {
	const session = new FakeSession();
	session.mode = "print";
	const runtime = new CopyOnSelectRuntime({
		measure,
		truncate,
		copyToClipboard: async () => {},
		readConfig: () => ({ ...DEFAULT_CONFIG }),
	});

	runtime.startSession(session);

	assert.equal(session.widgets.size, 0);
});
