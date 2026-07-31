import assert from "node:assert/strict";
import { test } from "node:test";
import { compositeLineFallback, paintToast } from "../toast.ts";

const measure = (text: string): number => [...text].length;
const composite = compositeLineFallback;
const label = "* Copied";

function paint(lines: string[], width: number): string[] {
	return paintToast(lines, width, { label, measure, composite });
}

test("toast lands in the bottom-right corner of a blank row", () => {
	const painted = paint(["first row", ""], 20);

	assert.equal(painted[0], "first row", "untouched rows stay identical");
	assert.equal(measure(painted[1] ?? ""), 19, "one column stays free at the right edge");
	assert.match(painted[1] ?? "", /\* Copied$/);
});

test("toast skips rows with visible text", () => {
	const painted = paint(["", "bottom row has text"], 30);

	assert.match(painted[0] ?? "", /\* Copied$/, "the blank row above is used");
	assert.equal(painted[1], "bottom row has text");
});

test("toast never writes into a background-padded box row", () => {
	// A user-message box pads itself with background-filled blank rows; writing
	// into one of those punches a hole in the box.
	const boxPadding = `\x1b[48;2;40;40;40m${" ".repeat(30)}\x1b[49m`;
	const lines = ["text above", boxPadding, boxPadding];

	assert.deepEqual(paint(lines, 30), lines, "frame is left untouched");
});

test("toast tolerates rows that only carry reset escapes", () => {
	const painted = paint(["text", "\x1b[0m"], 24);

	assert.match(painted[1] ?? "", /\* Copied$/);
});

test("toast is skipped when it cannot fit or there is nothing to paint on", () => {
	assert.deepEqual(paint([], 40), []);
	assert.deepEqual(paint([""], 8), [""], "narrow viewport keeps the frame untouched");
	assert.deepEqual(paintToast([""], 40, { label: "", measure, composite }), [""]);
});

test("toast does not mutate the original frame", () => {
	const lines = ["first row", ""];
	const painted = paint(lines, 20);

	assert.notEqual(painted, lines);
	assert.deepEqual(lines, ["first row", ""]);
});

test("toast only searches a few bottom rows", () => {
	const busy = "x".repeat(40);
	const lines = ["", busy, busy, busy, busy];

	assert.deepEqual(paint(lines, 30), lines, "a blank row far above is not used");
});

test("fallback composition keeps surrounding columns and drops base styling", () => {
	const composed = compositeLineFallback("\x1b[7mstyled\x1b[27m text", "OVER", 7, 4, 16);

	assert.equal(composed, "styled OVER");
});

test("pi-tui style composition is used when provided", () => {
	const calls: unknown[][] = [];
	const painted = paintToast([""], 20, {
		label,
		measure,
		composite: (...args) => {
			calls.push(args);
			return "composited";
		},
	});

	assert.deepEqual(painted, ["composited"]);
	assert.deepEqual(calls[0]?.slice(1), [label, 11, 8, 20], "overlay is placed with a one column margin");
});
