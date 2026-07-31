import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFade, DEFAULT_FADE_COLORS, fadeStepMs, hasSelection, normalizeFadeColors } from "../fade.ts";

const selected = "before\x1b[7mselected\x1b[27mafter";

test("detects reverse-video selections", () => {
	assert.ok(hasSelection([selected]));
	assert.ok(!hasSelection(["plain", "\x1b[1mbold\x1b[22m"]));
	assert.ok(!hasSelection([]));
});

test("repaints selections as an explicit background colour", () => {
	assert.equal(applyFade([selected], 244)[0], "before\x1b[48;5;244mselected\x1b[49mafter");
});

test("leaves unselected lines untouched and clamps the colour", () => {
	const lines = ["plain text", selected];
	const painted = applyFade(lines, 999);

	assert.equal(painted[0], "plain text");
	assert.match(painted[1] ?? "", /\x1b\[48;5;255m/);
	assert.match(applyFade(lines, -5)[1] ?? "", /\x1b\[48;5;0m/);
});

test("restores the background a message box had set", () => {
	const boxed = `\x1b[48;2;40;40;40mbefore\x1b[7mselected\x1b[27mafter\x1b[49m`;

	assert.equal(
		applyFade([boxed], 244)[0],
		"\x1b[48;2;40;40;40mbefore\x1b[48;5;244mselected\x1b[48;2;40;40;40mafter\x1b[49m",
		"the box background continues after the faded span",
	);
});

test("restores the default background when none was set", () => {
	assert.match(applyFade([selected], 244)[0] ?? "", /selected\x1b\[49mafter$/);
});

test("handles 256-colour and basic backgrounds", () => {
	const indexed = `\x1b[48;5;236mrow \x1b[7mpick\x1b[27m rest`;
	assert.match(applyFade([indexed], 240)[0] ?? "", /pick\x1b\[48;5;236m rest$/);

	const basic = `\x1b[44mrow \x1b[7mpick\x1b[27m rest`;
	assert.match(applyFade([basic], 240)[0] ?? "", /pick\x1b\[44m rest$/);
});

test("a reset before the selection drops back to the default background", () => {
	const line = `\x1b[48;5;236mstyled\x1b[0m plain \x1b[7mpick\x1b[27m tail`;

	assert.match(applyFade([line], 240)[0] ?? "", /pick\x1b\[49m tail$/);
});

test("handles multi-row selections", () => {
	const painted = applyFade(["\x1b[7mrow one\x1b[27m", "\x1b[7mrow two\x1b[27m"], 240);

	assert.ok(painted.every((line) => line.includes("\x1b[48;5;240m") && line.endsWith("\x1b[49m")));
});

test("colour ramps are normalized with a default fallback", () => {
	assert.deepEqual(normalizeFadeColors(undefined), DEFAULT_FADE_COLORS);
	assert.deepEqual(normalizeFadeColors([]), DEFAULT_FADE_COLORS);
	assert.deepEqual(normalizeFadeColors(["nope", null]), DEFAULT_FADE_COLORS);
	assert.deepEqual(normalizeFadeColors([300, -2, 12.6]), [255, 0, 13]);
});

test("step duration spreads the ramp across the configured time", () => {
	assert.equal(fadeStepMs(400, 5), 80);
	assert.equal(fadeStepMs(400, 0), 400);
	assert.equal(fadeStepMs(3, 5), 1, "never schedules a zero-length step");
});
