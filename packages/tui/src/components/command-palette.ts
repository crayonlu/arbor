/**
 * Command palette: a `/`-triggered overlay listing categorized slash commands
 * with subsequence (fuzzy) filtering. The app owns key dispatch while the
 * palette is open — printable chars refine the query, up/down move the
 * selection, Enter dispatches, Esc closes.
 */
import { BoxRenderable, type CliRenderer, SelectRenderable, TextRenderable } from "@opentui/core";
import { icons } from "../icons.ts";
import type { ArborTheme } from "../theme.ts";

export interface TuiCommandInfo {
	category: string;
	name: string;
	aliases?: string[];
	description: string;
	argumentHint?: string;
}

export interface PaletteSelection {
	category: string;
	name: string;
}

export interface CommandPalette {
	container: BoxRenderable;
	/** Current filtered, sorted results (in display order). */
	results: () => TuiCommandInfo[];
	/** Index of the highlighted result. */
	selectedIndex: () => number;
	/** Full path text to dispatch, e.g. `/session rewind`. */
	selectedText: () => string | null;
	/** Apply a query string (refilters + resets selection). */
	setQuery: (q: string) => void;
	move: (delta: number) => void;
	query: () => string;
}

/** Subsequence match: every char of `query` appears in order in `target`. */
function fuzzy(target: string, query: string): boolean {
	if (!query) return true;
	const t = target.toLowerCase();
	const q = query.toLowerCase();
	let ti = 0;
	for (let qi = 0; qi < q.length; qi++) {
		const ch = q[qi] as string;
		ti = t.indexOf(ch, ti);
		if (ti === -1) return false;
		ti++;
	}
	return true;
}

export function createCommandPalette(
	renderer: CliRenderer,
	theme: ArborTheme,
	commands: TuiCommandInfo[],
	opts: { width: number; maxHeight: number },
): CommandPalette {
	const container = new BoxRenderable(renderer, {
		flexDirection: "column",
		width: opts.width,
		border: true,
		borderColor: theme.accent,
		borderStyle: "single",
		paddingLeft: 1,
		paddingRight: 1,
		paddingTop: 0,
		paddingBottom: 0,
		zIndex: 10,
		position: "absolute",
	});
	container.setPosition({ left: 1, bottom: 3 });
	const queryLine = new TextRenderable(renderer, { content: `${icons.prompt}/`, fg: theme.accent });
	const select = new SelectRenderable(renderer, {
		options: [],
		selectedIndex: 0,
		textColor: theme.text,
		selectedBackgroundColor: theme.bgRun,
		selectedTextColor: theme.text,
		descriptionColor: theme.dim,
		showDescription: false,
		wrapSelection: false,
		height: opts.maxHeight,
		width: opts.width - 2,
	});
	container.add(queryLine);
	container.add(select);

	let query = "";
	let filtered: TuiCommandInfo[] = [];
	let idx = 0;

	function refilter(): void {
		filtered = commands
			.filter((c) => fuzzy(`${c.category} ${c.name} ${c.description}`, query))
			.sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
		idx = filtered.length > 0 ? 0 : 0;
		select.options = filtered.map((c) => ({
			name: `/${c.category} ${c.name}`,
			description: c.description,
		}));
		select.selectedIndex = idx;
	}

	return {
		container,
		results: () => filtered,
		selectedIndex: () => idx,
		selectedText(): string | null {
			const sel = filtered[idx];
			if (!sel) return null;
			return `/${sel.category} ${sel.name}`;
		},
		setQuery(q: string): void {
			query = q;
			queryLine.content = `${icons.prompt}/${q}`;
			refilter();
		},
		move(delta: number): void {
			if (filtered.length === 0) return;
			idx = (idx + delta + filtered.length) % filtered.length;
			select.selectedIndex = idx;
		},
		query: () => query,
	};
}

const RANK: Record<string, number> = {
	session: 0,
	model: 1,
	context: 2,
	mode: 3,
	tools: 4,
	display: 5,
	help: 6,
	extension: 7,
};
function categoryRank(c: string): number {
	return RANK[c] ?? 99;
}
