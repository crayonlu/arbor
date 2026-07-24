/** Path helpers shared by the built-in tools. */
import * as os from "node:os";
import * as path from "node:path";

/** Expand a leading `~` and resolve a possibly-relative path against cwd. */
export function resolveToCwd(inputPath: string, cwd: string): string {
	let p = inputPath;
	if (p === "~") {
		p = os.homedir();
	} else if (p.startsWith("~/")) {
		p = path.join(os.homedir(), p.slice(2));
	}
	return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

/** Render a path relative to cwd when it is inside it, otherwise absolute. */
export function displayPath(absolutePath: string, cwd: string): string {
	const rel = path.relative(cwd, absolutePath);
	if (rel === "") return ".";
	return rel.startsWith("..") ? absolutePath : rel;
}
