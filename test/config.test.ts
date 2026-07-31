import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_CONFIG,
	describeConfig,
	globalSettingsPath,
	normalizeConfig,
	projectSettingsPath,
	readConfig,
} from "../config.ts";

test("defaults are returned for missing or invalid values", () => {
	assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig(true), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig("nonsense"), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig([1, 2]), DEFAULT_CONFIG);
});

test("the default is to fade the highlight out", () => {
	assert.equal(DEFAULT_CONFIG.clearSelection, "fade");
	assert.ok(DEFAULT_CONFIG.fadeColors.length > 1, "the default ramp has multiple steps");
});

test("boolean shorthand disables the extension", () => {
	assert.deepEqual(normalizeConfig(false), { ...DEFAULT_CONFIG, enabled: false });
});

test("known keys are applied and clamped", () => {
	const config = normalizeConfig({
		copy: false,
		clearSelection: "delayed",
		delayMs: 99999,
		fadeMs: 1,
		fadeColors: [300, 10.4],
		toast: false,
		toastText: "  Copied  ",
		toastMs: 1,
	});

	assert.deepEqual(config, {
		enabled: true,
		copy: false,
		clearSelection: "delayed",
		delayMs: 5000,
		fadeMs: 60,
		fadeColors: [255, 10],
		toast: false,
		toastText: "Copied",
		toastMs: 200,
	});
});

test("clearSelection accepts every spelling and rejects junk", () => {
	assert.equal(normalizeConfig({ clearSelection: "immediate" }).clearSelection, "immediate");
	assert.equal(normalizeConfig({ clearSelection: true }).clearSelection, "immediate");
	assert.equal(normalizeConfig({ clearSelection: "fade" }).clearSelection, "fade");
	assert.equal(normalizeConfig({ clearSelection: "delayed" }).clearSelection, "delayed");
	assert.equal(normalizeConfig({ clearSelection: "keep" }).clearSelection, "keep");
	assert.equal(normalizeConfig({ clearSelection: false }).clearSelection, "keep");
	assert.equal(normalizeConfig({ clearSelection: "off" }).clearSelection, "keep");
	assert.equal(normalizeConfig({ clearSelection: "sideways" }).clearSelection, DEFAULT_CONFIG.clearSelection);
});

test("fade tuning is independent of the delayed linger", () => {
	const config = normalizeConfig({ fadeMs: 800, delayMs: 100 });

	assert.equal(config.fadeMs, 800);
	assert.equal(config.delayMs, 100);
	assert.deepEqual(normalizeConfig({ fadeColors: [] }).fadeColors, DEFAULT_CONFIG.fadeColors, "empty ramps fall back");
});

test("project settings override global settings per key", () => {
	const files: Record<string, Record<string, unknown>> = {
		"/home/user/.pi/agent/settings.json": { copyOnSelect: { toast: false, delayMs: 400 } },
		"/project/.pi/settings.json": { copyOnSelect: { delayMs: 50 } },
	};

	const config = readConfig({
		cwd: "/project",
		env: { PI_CODING_AGENT_DIR: "/home/user/.pi/agent" },
		readFile: (path) => files[path] ?? {},
	});

	assert.equal(config.delayMs, 50, "project value wins");
	assert.equal(config.toast, false, "global value is inherited");
	assert.equal(config.enabled, true);
});

test("missing settings files fall back to defaults", () => {
	assert.deepEqual(readConfig({ cwd: "/project", readFile: () => ({}) }), DEFAULT_CONFIG);
});

test("settings paths honor PI_CODING_AGENT_DIR and the config dir name", () => {
	assert.equal(globalSettingsPath({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent/settings.json");
	assert.match(globalSettingsPath({}), /\.pi\/agent\/settings\.json$/);
	assert.equal(projectSettingsPath("/project", ".pi"), "/project/.pi/settings.json");
});

test("config summary lists the active behavior", () => {
	assert.match(describeConfig(DEFAULT_CONFIG), /^copy-on-select on · copy on · clear fade \(400ms, 5 steps\) · toast on \(1500ms\)$/);
	assert.match(describeConfig({ ...DEFAULT_CONFIG, clearSelection: "delayed" }), /clear delayed \(250ms\)/);
	assert.match(describeConfig({ ...DEFAULT_CONFIG, clearSelection: "immediate" }), /clear immediate/);
	assert.match(describeConfig({ ...DEFAULT_CONFIG, clearSelection: "keep", toast: false }), /clear keep · toast off$/);
});
