import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractSelectionText,
	isLeftPress,
	isLeftRelease,
	isWheel,
	lineRange,
	orderPoints,
	parseSgrMousePackets,
	rowsUnchanged,
	SelectionTracker,
	sliceColumns,
	stripAnsi,
} from "../selection.ts";

/** Test measure: every code point counts as one column. */
const measure = (text: string): number => [...text].length;

function press(col: number, row: number): string {
	return `\x1b[<0;${col};${row}M`;
}

function drag(col: number, row: number): string {
	return `\x1b[<32;${col};${row}M`;
}

function release(col: number, row: number): string {
	return `\x1b[<0;${col};${row}m`;
}

test("parses SGR mouse reports", () => {
	const packets = parseSgrMousePackets(`${press(3, 5)}${drag(9, 6)}${release(9, 6)}`);

	assert.equal(packets.length, 3);
	assert.ok(isLeftPress(packets[0]!));
	assert.ok(packets[1]!.drag);
	assert.ok(isLeftRelease(packets[2]!));
	assert.deepEqual([packets[0]!.col, packets[0]!.row], [3, 5]);
});

test("ignores non-mouse input and detects wheel reports", () => {
	assert.deepEqual(parseSgrMousePackets("hello"), []);
	assert.ok(isWheel(parseSgrMousePackets("\x1b[<64;10;10M")[0]!));
	assert.ok(isWheel(parseSgrMousePackets("\x1b[<65;10;10M")[0]!));
});

test("strips ANSI styling and slices by visible columns", () => {
	assert.equal(stripAnsi("\x1b[7mhi\x1b[27m"), "hi");
	assert.equal(stripAnsi("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"), "link");
	assert.equal(sliceColumns("hello world", 6, 11, measure), "world");
	assert.equal(sliceColumns("hello", 0, Number.POSITIVE_INFINITY, measure), "hello");
	assert.equal(sliceColumns("hello", 3, 3, measure), "");
});

test("orders points and extracts multi-line selections", () => {
	const lines = ["first line", "second line", "third line"];
	const range = orderPoints({ row: 3, col: 5 }, { row: 1, col: 6 });

	assert.deepEqual(range.start, { row: 1, col: 6 });
	assert.equal(extractSelectionText(lines, range, measure), "line\nsecond line\nthird");
});

test("extraction trims trailing whitespace per line", () => {
	const lines = ["padded   ", "text"];
	const range = orderPoints({ row: 1, col: 0 }, { row: 2, col: 4 });

	assert.equal(extractSelectionText(lines, range, measure), "padded\ntext");
});

test("extraction of unrendered rows yields nothing", () => {
	assert.equal(extractSelectionText(["only row"], orderPoints({ row: 1, col: 0 }, { row: 4, col: 2 }), measure), "");
});

test("lineRange spans the whole rendered line", () => {
	assert.deepEqual(lineRange(["\x1b[7mabc\x1b[27m"], 1, measure), {
		start: { row: 1, col: 0 },
		end: { row: 1, col: 3 },
	});
	assert.equal(lineRange([], 1, measure), null);
});

test("rowsUnchanged detects viewport movement", () => {
	const range = orderPoints({ row: 1, col: 0 }, { row: 2, col: 3 });

	assert.ok(rowsUnchanged(["a", "b"], ["\x1b[7ma\x1b[27m", "b"], range), "styling changes are ignored");
	assert.ok(!rowsUnchanged(["a", "b"], ["a", "shifted"], range));
	assert.ok(!rowsUnchanged(["a", "b"], ["a"], range));
});

test("tracker copies a drag selection", () => {
	const lines = ["hello world", "second line"];
	const tracker = new SelectionTracker({ measure });
	const packets = parseSgrMousePackets(`${press(1, 1)}${drag(6, 1)}${release(6, 1)}`);

	assert.equal(tracker.handlePacket(packets[0]!, lines), null);
	assert.equal(tracker.handlePacket(packets[1]!, lines), null);
	assert.equal(tracker.handlePacket(packets[2]!, lines), "hello");
});

test("tracker ignores plain clicks", () => {
	const lines = ["hello world"];
	const tracker = new SelectionTracker({ measure });

	tracker.handlePacket(parseSgrMousePackets(press(4, 1))[0]!, lines);
	assert.equal(tracker.handlePacket(parseSgrMousePackets(release(4, 1))[0]!, lines), null);
});

test("tracker selects the whole line on double click", () => {
	const lines = ["  spaced text  "];
	let now = 1000;
	const tracker = new SelectionTracker({ measure, now: () => now });

	tracker.handlePacket(parseSgrMousePackets(press(4, 1))[0]!, lines);
	tracker.handlePacket(parseSgrMousePackets(release(4, 1))[0]!, lines);
	now += 100;
	tracker.handlePacket(parseSgrMousePackets(press(4, 1))[0]!, lines);

	assert.equal(tracker.handlePacket(parseSgrMousePackets(release(4, 1))[0]!, lines), "  spaced text");
});

test("tracker treats a slow second click as a new selection", () => {
	const lines = ["hello world"];
	let now = 1000;
	const tracker = new SelectionTracker({ measure, now: () => now });

	tracker.handlePacket(parseSgrMousePackets(press(4, 1))[0]!, lines);
	tracker.handlePacket(parseSgrMousePackets(release(4, 1))[0]!, lines);
	now += 5000;
	tracker.handlePacket(parseSgrMousePackets(press(4, 1))[0]!, lines);

	assert.equal(tracker.handlePacket(parseSgrMousePackets(release(4, 1))[0]!, lines), null);
});

test("tracker refuses to copy when selected rows changed mid-drag", () => {
	const tracker = new SelectionTracker({ measure });

	tracker.handlePacket(parseSgrMousePackets(press(1, 1))[0]!, ["hello world"]);
	tracker.handlePacket(parseSgrMousePackets(drag(6, 1))[0]!, ["hello world"]);

	assert.equal(tracker.handlePacket(parseSgrMousePackets(release(6, 1))[0]!, ["scrolled away"]), null);
});

test("tracker abandons a selection when the wheel scrolls", () => {
	const lines = ["hello world"];
	const tracker = new SelectionTracker({ measure });

	tracker.handlePacket(parseSgrMousePackets(press(1, 1))[0]!, lines);
	tracker.handlePacket(parseSgrMousePackets("\x1b[<64;5;1M")[0]!, lines);

	assert.equal(tracker.handlePacket(parseSgrMousePackets(release(6, 1))[0]!, lines), null);
});

test("tracker resets state on demand", () => {
	const lines = ["hello world"];
	const tracker = new SelectionTracker({ measure });

	tracker.handlePacket(parseSgrMousePackets(press(1, 1))[0]!, lines);
	tracker.reset();

	assert.equal(tracker.handlePacket(parseSgrMousePackets(release(6, 1))[0]!, lines), null);
});
