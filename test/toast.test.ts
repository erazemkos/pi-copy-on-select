import assert from "node:assert/strict";
import { test } from "node:test";
import { compositeLineFallback, paintToast } from "../toast.ts";

const measure = (text: string): number => [...text].length;
const composite = compositeLineFallback;
const label = "* Copied";

function paint(lines: string[], width: number): string[] {
	return paintToast(lines, width, { label, measure, composite });
}

test("toast lands in the bottom-right corner of the last row", () => {
	const painted = paint(["first row", "last row"], 20);

	assert.equal(painted[0], "first row", "untouched rows stay identical");
	assert.equal(painted[1], "last row           ".slice(0, 11) + label + " ".repeat(0), "toast is right-aligned");
	assert.equal(measure(painted[1] ?? ""), 19, "one column stays free at the right edge");
});

test("toast prefers a row whose tail is blank", () => {
	const painted = paint(["short", "this bottom row is completely full of text here"], 30);

	assert.match(painted[0] ?? "", /\* Copied$/, "blank-tailed row is used");
	assert.equal(painted[1], "this bottom row is completely full of text here", "busy row is left alone");
});

test("toast falls back to the last row when no tail is blank", () => {
	const long = "x".repeat(40);
	const painted = paint([long, long, long, long], 30);

	assert.match(painted[3] ?? "", /\* Copied/, "last row is used as a fallback");
	assert.equal(painted[0], long);
});

test("toast is skipped when it cannot fit or there is nothing to paint on", () => {
	assert.deepEqual(paint([], 40), []);
	assert.deepEqual(paint(["row"], 8), ["row"], "narrow viewport keeps the frame untouched");
	assert.deepEqual(paintToast(["row"], 40, { label: "", measure, composite }), ["row"]);
});

test("toast does not mutate the original frame", () => {
	const lines = ["first row", "last row"];
	const painted = paint(lines, 20);

	assert.notEqual(painted, lines);
	assert.deepEqual(lines, ["first row", "last row"]);
});

test("fallback composition keeps surrounding columns and drops base styling", () => {
	const composed = compositeLineFallback("\x1b[7mstyled\x1b[27m text", "OVER", 7, 4, 16);

	assert.equal(composed, "styled OVER");
});

test("pi-tui style composition is used when provided", () => {
	const calls: unknown[][] = [];
	const painted = paintToast(["row"], 20, {
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
