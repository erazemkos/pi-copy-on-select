/**
 * Settings handling for pi-copy-on-select.
 *
 * Config lives under the `copyOnSelect` key in pi's settings files:
 *   - global:  ~/.pi/agent/settings.json (or $PI_CODING_AGENT_DIR/settings.json)
 *   - project: <cwd>/.pi/settings.json  (overrides global, merged per key)
 *
 * Dependency-free on purpose so it can be unit tested without pi installed.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClearSelectionMode = "immediate" | "fade" | "off";

export interface CopyOnSelectConfig {
	/** Master switch for all behavior. */
	enabled: boolean;
	/** Copy the selection to the system clipboard on mouse release. */
	copy: boolean;
	/** What happens to the highlight after a copy. */
	clearSelection: ClearSelectionMode;
	/** How long the highlight lingers before clearing when `clearSelection` is `"fade"`. */
	fadeMs: number;
	/** Show a bottom-right toast after a copy. */
	toast: boolean;
	/** Toast message text. */
	toastText: string;
	/** How long the toast stays visible. */
	toastMs: number;
}

export const DEFAULT_CONFIG: CopyOnSelectConfig = {
	enabled: true,
	copy: true,
	clearSelection: "fade",
	fadeMs: 250,
	toast: true,
	toastText: "Copied to clipboard",
	toastMs: 1500,
};

const SETTINGS_KEY = "copyOnSelect";
const MIN_FADE_MS = 0;
const MAX_FADE_MS = 5000;
const MIN_TOAST_MS = 200;
const MAX_TOAST_MS = 10000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function clampedInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function clearSelectionMode(value: unknown, fallback: ClearSelectionMode): ClearSelectionMode {
	if (value === false) return "off";
	if (value === true) return "immediate";
	if (value === "immediate" || value === "fade" || value === "off") return value;
	return fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/** Normalizes a raw `copyOnSelect` settings value, filling in defaults. */
export function normalizeConfig(raw: unknown, base: CopyOnSelectConfig = DEFAULT_CONFIG): CopyOnSelectConfig {
	if (raw === false) return { ...base, enabled: false };
	if (raw === true || raw === undefined || raw === null) return { ...base };
	if (!isRecord(raw)) return { ...base };

	return {
		enabled: boolean(raw.enabled, base.enabled),
		copy: boolean(raw.copy, base.copy),
		clearSelection: clearSelectionMode(raw.clearSelection, base.clearSelection),
		fadeMs: clampedInteger(raw.fadeMs, base.fadeMs, MIN_FADE_MS, MAX_FADE_MS),
		toast: boolean(raw.toast, base.toast),
		toastText: nonEmptyString(raw.toastText, base.toastText),
		toastMs: clampedInteger(raw.toastMs, base.toastMs, MIN_TOAST_MS, MAX_TOAST_MS),
	};
}

function readJsonFile(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR?.trim();
	return agentDir ? join(agentDir, "settings.json") : join(homedir(), ".pi", "agent", "settings.json");
}

export function projectSettingsPath(cwd: string, configDirName = ".pi"): string {
	return join(cwd, configDirName, "settings.json");
}

export interface ReadConfigOptions {
	cwd: string;
	configDirName?: string;
	env?: NodeJS.ProcessEnv;
	/** Injected for tests. */
	readFile?: (path: string) => Record<string, unknown>;
}

/** Reads and merges the effective config from global and project settings. */
export function readConfig(options: ReadConfigOptions): CopyOnSelectConfig {
	const read = options.readFile ?? readJsonFile;
	const globalConfig = normalizeConfig(read(globalSettingsPath(options.env))[SETTINGS_KEY]);
	const projectRaw = read(projectSettingsPath(options.cwd, options.configDirName))[SETTINGS_KEY];

	return normalizeConfig(projectRaw, globalConfig);
}

export function describeConfig(config: CopyOnSelectConfig): string {
	const parts = [
		`copy-on-select ${config.enabled ? "on" : "off"}`,
		`copy ${config.copy ? "on" : "off"}`,
		`clear ${config.clearSelection}${config.clearSelection === "fade" ? ` (${config.fadeMs}ms)` : ""}`,
		`toast ${config.toast ? `on (${config.toastMs}ms)` : "off"}`,
	];

	return parts.join(" · ");
}
