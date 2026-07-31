/**
 * pi-copy-on-select
 *
 * Copy-on-select for pi's chat viewport: drag-select text with the mouse, get it
 * on the system clipboard, see a bottom-right toast, and watch the highlight go
 * away by itself.
 *
 * Selections are reconstructed from raw SGR mouse reports and read straight off
 * the rendered viewport, so clipboard handling is independent of any other
 * extension. A terminal-splitting editor that owns mouse reporting and paints the
 * highlight is required (for example pi-powerline-footer's fixed editor); without
 * one the extension stays inert and the terminal keeps its native selection.
 */

import { CONFIG_DIR_NAME, copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readConfig } from "./config.ts";
import { CopyOnSelectRuntime, type SessionLike } from "./runtime.ts";

const COMMAND_ARGUMENTS = [
	"on",
	"off",
	"toast on",
	"toast off",
	"clear immediate",
	"clear fade",
	"clear off",
	"reload",
];

export default function (pi: ExtensionAPI) {
	const runtime = new CopyOnSelectRuntime({
		measure: visibleWidth,
		truncate: (text, width) => truncateToWidth(text, width, ""),
		copyToClipboard,
		readConfig: (cwd) => readConfig({ cwd, configDirName: CONFIG_DIR_NAME }),
	});

	pi.on("session_start", (_event, ctx) => {
		runtime.startSession(ctx as unknown as SessionLike);
	});

	pi.on("session_shutdown", () => {
		runtime.stopSession();
	});

	pi.registerCommand("copy-on-select", {
		description: "Show or change copy-on-select behavior for this session",
		getArgumentCompletions: (prefix: string) => {
			const items = COMMAND_ARGUMENTS.filter((option) => option.startsWith(prefix)).map((option) => ({
				value: option,
				label: option,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const { message, level } = runtime.handleCommand(args, ctx as unknown as SessionLike);
			ctx.ui.notify(message, level);
		},
	});
}
