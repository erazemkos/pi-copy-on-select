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

test("boolean shorthand disables the extension", () => {
	assert.deepEqual(normalizeConfig(false), { ...DEFAULT_CONFIG, enabled: false });
});

test("known keys are applied and clamped", () => {
	const config = normalizeConfig({
		copy: false,
		clearSelection: "immediate",
		fadeMs: 99999,
		toast: false,
		toastText: "  Copied  ",
		toastMs: 1,
	});

	assert.deepEqual(config, {
		enabled: true,
		copy: false,
		clearSelection: "immediate",
		fadeMs: 5000,
		toast: false,
		toastText: "Copied",
		toastMs: 200,
	});
});

test("clearSelection accepts booleans and rejects junk", () => {
	assert.equal(normalizeConfig({ clearSelection: false }).clearSelection, "off");
	assert.equal(normalizeConfig({ clearSelection: true }).clearSelection, "immediate");
	assert.equal(normalizeConfig({ clearSelection: "sideways" }).clearSelection, DEFAULT_CONFIG.clearSelection);
});

test("project settings override global settings per key", () => {
	const files: Record<string, Record<string, unknown>> = {
		"/home/user/.pi/agent/settings.json": { copyOnSelect: { toast: false, fadeMs: 400 } },
		"/project/.pi/settings.json": { copyOnSelect: { fadeMs: 50 } },
	};

	const config = readConfig({
		cwd: "/project",
		env: { PI_CODING_AGENT_DIR: "/home/user/.pi/agent" },
		readFile: (path) => files[path] ?? {},
	});

	assert.equal(config.fadeMs, 50, "project value wins");
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
	assert.equal(
		describeConfig(DEFAULT_CONFIG),
		"copy-on-select on · copy on · clear fade (250ms) · toast on (1500ms)",
	);
	assert.match(describeConfig({ ...DEFAULT_CONFIG, clearSelection: "off", toast: false }), /clear off · toast off$/);
});
