/**
 * Minimal glob-to-regex conversion shared by find/grep. Supports `*`, `**`,
 * `?`. Bare patterns without `/` match at any depth; path patterns are
 * anchored to the search root.
 */
export function globToRegex(glob: string): RegExp {
	let regexStr = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				regexStr += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else {
				regexStr += "[^/]*";
			}
		} else if (ch === "?") {
			regexStr += "[^/]";
		} else if (ch !== undefined && "\\^$.|+()[]{}".includes(ch)) {
			regexStr += `\\${ch}`;
		} else {
			regexStr += ch;
		}
	}
	return new RegExp(glob.includes("/") ? `^${regexStr}$` : `(^|/)${regexStr}$`);
}
