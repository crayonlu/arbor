import { type ColorInput, SyntaxStyle, type ThemeTokenStyle } from "@opentui/core";

export interface ArborTheme {
	bg: ColorInput;
	bgPanel: ColorInput;
	bgInput: ColorInput;
	bgUser: ColorInput;
	bgRun: ColorInput;
	bgQueue: ColorInput;
	border: ColorInput;
	borderDim: ColorInput;
	text: ColorInput;
	muted: ColorInput;
	dim: ColorInput;
	accent: ColorInput;
	success: ColorInput;
	warn: ColorInput;
	error: ColorInput;
	info: ColorInput;
	think: ColorInput;
	addFg: ColorInput;
	addBg: ColorInput;
	delFg: ColorInput;
	delBg: ColorInput;
	codeBg: ColorInput;
	kw: ColorInput;
	str: ColorInput;
	fn: ColorInput;
	com: ColorInput;
	num: ColorInput;
	typ: ColorInput;
}

// OpenTUI parses #rrggbb or #rrggbbaa (alpha 0-255); it does NOT accept rgba() strings.
const alpha = (hex: string, a: number): string => {
	const h = hex.replace("#", "");
	const ah = Math.round(a * 255)
		.toString(16)
		.padStart(2, "0");
	return `#${h}${ah}`;
};

export const darkTheme: ArborTheme = {
	bg: "#141418",
	bgPanel: alpha("#b4bcc8", 0.05),
	bgInput: alpha("#b4bcc8", 0.07),
	bgUser: alpha("#b4bcc8", 0.06),
	bgRun: alpha("#f0c674", 0.06),
	bgQueue: alpha("#f0c674", 0.05),
	border: alpha("#b4bcc8", 0.14),
	borderDim: alpha("#b4bcc8", 0.08),
	text: "#d4d4d4",
	muted: "#808080",
	dim: "#666666",
	accent: "#8abeb7",
	success: "#b5bd68",
	warn: "#f0c674",
	error: "#cc6666",
	info: "#81a2be",
	think: "#9575cd",
	addFg: "#b5bd68",
	addBg: alpha("#b5bd68", 0.1),
	delFg: "#cc6666",
	delBg: alpha("#cc6666", 0.1),
	codeBg: alpha("#000000", 0.25),
	kw: "#569cd6",
	str: "#ce9178",
	fn: "#dcdcaa",
	com: "#6a9955",
	num: "#b5cea8",
	typ: "#4ec9b0",
};

/** Tree-sitter token styles derived from the theme, for markdown/diff/code. */
export function buildSyntaxStyle(t: ArborTheme): SyntaxStyle {
	const tokens: ThemeTokenStyle[] = [
		{ scope: ["keyword", "storage.type", "storage.modifier"], style: { foreground: t.kw } },
		{ scope: ["string"], style: { foreground: t.str } },
		{ scope: ["comment"], style: { foreground: t.com, italic: true } },
		{ scope: ["entity.name.function", "support.function"], style: { foreground: t.fn } },
		{ scope: ["constant.numeric"], style: { foreground: t.num } },
		{ scope: ["entity.name.type", "support.type"], style: { foreground: t.typ } },
	];
	return SyntaxStyle.fromTheme(tokens);
}
