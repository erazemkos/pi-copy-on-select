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
import { DEFAULT_FADE_COLORS, normalizeFadeColors } from "./fade.ts";

/**
 * What happens to the highlight after a copy.
 * - `immediate`: drop it as soon as the mouse is released
 * - `fade`: dim it down a colour ramp over `fadeMs`, then drop it
 * - `delayed`: leave it fully lit for `delayMs`, then drop it
 * - `keep`: never drop it; the owning editor decides
 */
export type ClearSelectionMode = "immediate" | "fade" | "delayed" | "keep";

export interface CopyOnSelectConfig {
	/** Master switch for all behavior. */
	enabled: boolean;
	/** Copy the selection to the system clipboard on mouse release. */
	copy: boolean;
	/** When to drop the highlight after a copy. */
	clearSelection: ClearSelectionMode;
	/** Linger time before dropping the highlight when `clearSelection` is `"delayed"`. */
	delayMs: number;
	/** Fade duration when `clearSelection` is `"fade"`. */
	fadeMs: number;
	/** xterm-256 colour indexes the fade steps through. */
	fadeColors: number[];
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
	delayMs: 250,
	fadeMs: 400,
	fadeColors: [...DEFAULT_FADE_COLORS],
	toast: true,
	toastText: "Copied to clipboard",
	toastMs: 1500,
};

const SETTINGS_KEY = "copyOnSelect";
const MIN_DELAY_MS = 0;
const MAX_DELAY_MS = 5000;
const MIN_FADE_MS = 60;
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

/** Accepts the current modes plus the `off`/boolean spellings. */
function clearSelectionMode(value: unknown, fallback: ClearSelectionMode): ClearSelectionMode {
	if (value === true) return "immediate";
	if (value === false || value === "off" || value === "never" || value === "keep") return "keep";
	if (value === "immediate" || value === "fade" || value === "delayed") return value;
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
		delayMs: clampedInteger(raw.delayMs, base.delayMs, MIN_DELAY_MS, MAX_DELAY_MS),
		fadeMs: clampedInteger(raw.fadeMs, base.fadeMs, MIN_FADE_MS, MAX_FADE_MS),
		fadeColors: raw.fadeColors === undefined ? [...base.fadeColors] : normalizeFadeColors(raw.fadeColors),
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
	const clear = config.clearSelection === "delayed"
		? `delayed (${config.delayMs}ms)`
		: config.clearSelection === "fade"
			? `fade (${config.fadeMs}ms, ${config.fadeColors.length} steps)`
			: config.clearSelection;

	return [
		`copy-on-select ${config.enabled ? "on" : "off"}`,
		`copy ${config.copy ? "on" : "off"}`,
		`clear ${clear}`,
		`toast ${config.toast ? `on (${config.toastMs}ms)` : "off"}`,
	].join(" · ");
}
