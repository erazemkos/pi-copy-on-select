import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToastLine } from "../toast.ts";

const style = {
	icon: (text: string) => `<i>${text}</i>`,
	text: (text: string) => `<t>${text}</t>`,
};

const metrics = {
	measure: (text: string) => [...text.replace(/<\/?[it]>/g, "")].length,
	truncate: (text: string, width: number) => [...text].slice(0, width).join(""),
};

test("toast is right-aligned and fills the given width", () => {
	const [line] = renderToastLine("Copied to clipboard", 30, style, metrics);

	assert.ok(line);
	assert.equal(metrics.measure(line), 30, "line must fill the widget width exactly");
	assert.match(line, /^ {8}<i>✓<\/i> <t>Copied to clipboard<\/t> $/);
});

test("toast truncates instead of overflowing narrow widgets", () => {
	const [line] = renderToastLine("Copied to clipboard", 10, style, metrics);

	assert.ok(line);
	assert.equal(metrics.measure(line), 10);
});

test("toast renders nothing for tiny widths or blank messages", () => {
	assert.deepEqual(renderToastLine("Copied", 3, style, metrics), []);
	assert.deepEqual(renderToastLine("   ", 40, style, metrics), []);
});
