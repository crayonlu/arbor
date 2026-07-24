/**
 * TUI ExtensionUi: maps the extension/ask UI surface onto terminal overlays.
 *
 * One modal layer (absolute, high zIndex) hosts the active prompt. The app
 * delegates keypresses to `handleKey` first (returns true when consumed) and
 * calls `sync()` each render so the layer shows/hides with prompt state.
 * `notify` posts a transient toast that self-clears.
 */

import type { AskUiQuestion, ExtensionUi } from "@arbor-space/core";
import {
	BoxRenderable,
	type CliRenderer,
	InputRenderable,
	SelectRenderable,
	TextRenderable,
} from "@opentui/core";
import { icons } from "./icons.ts";
import type { ArborTheme } from "./theme.ts";

type Mode =
	| { kind: "confirm"; title: string; message: string; resolve: (v: boolean) => void; index: 0 | 1 }
	| {
			kind: "select";
			title: string;
			options: string[];
			resolve: (v: string | string[] | undefined) => void;
			index: number;
			multi: boolean;
			chosen: Set<number>;
	  }
	| { kind: "input"; title: string; resolve: (v: string | undefined) => void };

export interface TuiExtensionUi extends ExtensionUi {
	mount: (renderer: CliRenderer, theme: ArborTheme) => void;
	handleKey: (key: { name: string; ctrl: boolean; shift: boolean }) => boolean;
	sync: () => void;
	readonly active: () => boolean;
}

interface Toast {
	node: TextRenderable;
	expires: number;
}

export function createTuiExtensionUi(): TuiExtensionUi {
	let renderer: CliRenderer | null = null;
	let theme: ArborTheme | null = null;
	let layer: BoxRenderable | null = null;
	let titleNode: TextRenderable | null = null;
	let bodyHost: BoxRenderable | null = null;
	let inputField: InputRenderable | null = null;
	let selectWidget: SelectRenderable | null = null;
	let hintNode: TextRenderable | null = null;
	let mode: Mode | null = null;
	const toasts: Toast[] = [];

	function ensureLayer(): void {
		if (!renderer || !theme || layer) return;
		layer = new BoxRenderable(renderer, {
			flexDirection: "column",
			width: "60%",
			border: true,
			borderColor: theme.accent,
			borderStyle: "single",
			paddingLeft: 1,
			paddingRight: 1,
			zIndex: 50,
			position: "absolute",
		});
		layer.setPosition({ left: 2, top: 2 });
		titleNode = new TextRenderable(renderer, { content: "", fg: theme.accent });
		bodyHost = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" });
		hintNode = new TextRenderable(renderer, { content: "", fg: theme.dim });
		layer.add(titleNode);
		layer.add(bodyHost);
		layer.add(hintNode);
		renderer.root.add(layer);
		layer.visible = false;
	}

	function clearBody(): void {
		if (!bodyHost || !renderer) return;
		if (inputField) {
			bodyHost.remove(inputField);
			inputField = null;
		}
		if (selectWidget) {
			bodyHost.remove(selectWidget);
			selectWidget = null;
		}
	}

	function close(result: () => void): void {
		result();
		mode = null;
		clearBody();
		if (layer) layer.visible = false;
		if (renderer) renderer.requestRender();
	}

	function show(): void {
		ensureLayer();
		if (!layer || !titleNode || !hintNode || !renderer || !theme) return;
		layer.visible = true;
		const m = mode;
		if (!m) return;
		titleNode.content = m.title;
		clearBody();
		if (m.kind === "confirm") {
			hintNode.content = `${icons.prompt}Enter to confirm  Esc to cancel`;
			renderConfirm(m);
		} else if (m.kind === "select") {
			hintNode.content = m.multi
				? `${icons.prompt}Space toggle  Enter confirm  Esc cancel`
				: `${icons.prompt}Enter to pick  Esc to cancel`;
			renderSelect(m);
		} else {
			hintNode.content = `${icons.prompt}Enter to submit  Esc to cancel`;
			renderInput(m);
		}
		renderer.requestRender();
	}

	function renderConfirm(m: Extract<Mode, { kind: "confirm" }>): void {
		if (!bodyHost || !renderer || !theme) return;
		const line = new TextRenderable(renderer, {
			content: m.message,
			fg: theme.text,
		});
		bodyHost.add(line);
		const opts = new TextRenderable(renderer, {
			content: `${m.index === 0 ? "●" : "○"} Yes    ${m.index === 1 ? "●" : "○"} No`,
			fg: theme.text,
		});
		bodyHost.add(opts);
	}

	function renderSelect(m: Extract<Mode, { kind: "select" }>): void {
		if (!bodyHost || !renderer || !theme) return;
		selectWidget = new SelectRenderable(renderer, {
			options: m.options.map((label, i) => ({
				name: `${m.chosen.has(i) ? "✓" : " "} ${label}`,
				description: label,
			})),
			selectedIndex: m.index,
			textColor: theme.text,
			selectedBackgroundColor: theme.bgRun,
			selectedTextColor: theme.text,
			descriptionColor: theme.dim,
			showDescription: false,
			wrapSelection: false,
			height: Math.min(m.options.length, 10),
			width: "100%",
		});
		bodyHost.add(selectWidget);
	}

	function renderInput(m: Extract<Mode, { kind: "input" }>): void {
		if (!bodyHost || !renderer || !theme) return;
		inputField = new InputRenderable(renderer, {
			placeholder: m.title,
			textColor: theme.text,
			placeholderColor: theme.dim,
		});
		bodyHost.add(inputField);
		inputField.focus();
	}

	const ui: TuiExtensionUi = {
		mount(r, t) {
			renderer = r;
			theme = t;
		},
		active: () => mode !== null,
		notify(message, level = "info"): void {
			if (!renderer || !theme) return;
			const fg = level === "error" ? theme.error : level === "warn" ? theme.warn : theme.info;
			const node = new TextRenderable(renderer, { content: `${icons.bullet} ${message}`, fg });
			node.zIndex = 40;
			node.position = "absolute";
			node.setPosition({ left: 2, top: 0 });
			renderer.root.add(node);
			toasts.push({ node, expires: 0 });
		},
		confirm(title, message): Promise<boolean> {
			return new Promise((resolve) => {
				mode = { kind: "confirm", title, message, resolve, index: 0 };
				show();
			});
		},
		input(title, placeholder): Promise<string | undefined> {
			return new Promise((resolve) => {
				mode = { kind: "input", title: placeholder ?? title, resolve };
				show();
			});
		},
		select(title, options): Promise<string | undefined> {
			return new Promise((resolve) => {
				mode = {
					kind: "select",
					title,
					options,
					resolve: (v) => resolve(typeof v === "string" ? v : undefined),
					index: 0,
					multi: false,
					chosen: new Set(),
				};
				show();
			});
		},
		ask(question: AskUiQuestion): Promise<string[] | undefined> {
			return new Promise((resolve) => {
				const options = question.options.map((o: { label: string }) => o.label);
				mode = {
					kind: "select",
					title: question.question,
					options,
					resolve: (v) => resolve(Array.isArray(v) ? v : v === undefined ? undefined : [v]),
					index: 0,
					multi: question.multiSelect === true,
					chosen: new Set<number>(),
				};
				show();
			});
		},
		handleKey(key): boolean {
			const m = mode;
			if (!m) return false;
			if (key.name === "escape") {
				if (m.kind === "confirm") close(() => m.resolve(false));
				else if (m.kind === "select") close(() => m.resolve(undefined));
				else close(() => m.resolve(undefined));
				return true;
			}
			if (m.kind === "confirm") {
				if (key.name === "left") m.index = 0;
				else if (key.name === "right") m.index = 1;
				else if (key.name === "return") {
					close(() => m.resolve(m.index === 0));
					return true;
				} else return true;
				show();
				return true;
			}
			if (m.kind === "select") {
				if (key.name === "up") m.index = (m.index - 1 + m.options.length) % m.options.length;
				else if (key.name === "down") m.index = (m.index + 1) % m.options.length;
				else if (key.name === "space" && m.multi) {
					if (m.chosen.has(m.index)) m.chosen.delete(m.index);
					else m.chosen.add(m.index);
				} else if (key.name === "return") {
					if (m.multi) {
						const picks = [...m.chosen].sort((a, b) => a - b).map((i) => m.options[i] as string);
						close(() => m.resolve(picks.length > 0 ? picks : undefined));
					} else {
						const pick = m.options[m.index] as string;
						close(() => m.resolve(pick));
					}
					return true;
				} else return true;
				show();
				return true;
			}
			// input: InputRenderable handles its own keys; only intercept Enter/Esc.
			if (key.name === "return") {
				const val = inputField?.value ?? "";
				close(() => m.resolve(val.length > 0 ? val : undefined));
				return true;
			}
			return false;
		},
		sync(): void {
			// No per-frame work today; placeholder for toast expiry in a real clock.
		},
	};

	return ui;
}
