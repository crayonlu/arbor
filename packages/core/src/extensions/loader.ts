/**
 * Extension discovery and loading.
 *
 * Locations (all optional):
 * - ~/.arbor/extensions/*.ts and ~/.arbor/extensions/<dir>/index.ts (global)
 * - <cwd>/.arbor/extensions/*.ts and <dir>/index.ts (project)
 * - explicit paths from settings/CLI
 *
 * Node 24 runs TypeScript directly (type stripping), so extensions are
 * imported as ES modules without a build step.
 */
import { readdir, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionRunner } from "./runner.ts";
import type { ExtensionFactory } from "./types.ts";

export interface DiscoverOptions {
	cwd: string;
	/** Global extensions directory. Default: ~/.arbor/extensions */
	globalDir?: string;
	/** Extra extension file/directory paths (settings `extensions[]`, CLI -e). */
	extraPaths?: string[];
	/** Disable discovery (explicit extraPaths still load). */
	noDiscovery?: boolean;
}

async function isDirectory(p: string): Promise<boolean> {
	return stat(p).then(
		(s) => s.isDirectory(),
		() => false,
	);
}

async function isFile(p: string): Promise<boolean> {
	return stat(p).then(
		(s) => s.isFile(),
		() => false,
	);
}

/** Collect extension entry files from one extensions directory. */
async function collectFromDir(dir: string): Promise<string[]> {
	if (!(await isDirectory(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
			files.push(full);
		} else if (entry.isDirectory()) {
			for (const index of ["index.ts", "index.js"]) {
				const indexPath = path.join(full, index);
				if (await isFile(indexPath)) {
					files.push(indexPath);
					break;
				}
			}
		}
	}
	return files;
}

/** Resolve one extraPath: a file loads directly, a directory loads like an extensions dir. */
async function collectExtraPath(p: string): Promise<string[]> {
	if (await isFile(p)) return [p];
	if (await isDirectory(p)) {
		for (const index of ["index.ts", "index.js"]) {
			const indexPath = path.join(p, index);
			if (await isFile(indexPath)) return [indexPath];
		}
		return collectFromDir(p);
	}
	return [];
}

/** Discover extension entry files in load order: global → project → extra. */
export async function discoverExtensionPaths(options: DiscoverOptions): Promise<string[]> {
	const files: string[] = [];
	if (!options.noDiscovery) {
		const globalDir = options.globalDir ?? path.join(os.homedir(), ".arbor", "extensions");
		files.push(...(await collectFromDir(globalDir)));
		files.push(...(await collectFromDir(path.join(options.cwd, ".arbor", "extensions"))));
	}
	for (const extra of options.extraPaths ?? []) {
		files.push(...(await collectExtraPath(path.resolve(options.cwd, extra))));
	}
	// De-duplicate while keeping first-seen order.
	return [...new Set(files)];
}

/** Import and register each discovered extension into the runner. */
export async function loadExtensions(
	runner: ExtensionRunner,
	paths: string[],
): Promise<{ loaded: string[]; failed: { path: string; error: Error }[] }> {
	const loaded: string[] = [];
	const failed: { path: string; error: Error }[] = [];
	for (const extensionPath of paths) {
		try {
			const module = (await import(pathToFileURL(extensionPath).href)) as {
				default?: ExtensionFactory;
			};
			if (typeof module.default !== "function") {
				throw new Error("Extension must export a default factory function");
			}
			await runner.register(module.default, extensionPath);
			loaded.push(extensionPath);
		} catch (error) {
			failed.push({
				path: extensionPath,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
	return { loaded, failed };
}
