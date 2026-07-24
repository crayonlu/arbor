/**
 * Shared truncation for tool outputs. Two independent limits — lines and
 * bytes — whichever is hit first wins. Never returns partial lines, except
 * the bash tail case where the newest output matters most.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Keep the first N lines/bytes. Suitable for file reads and search output. */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLines(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines };
	}

	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (const line of lines) {
		if (kept.length >= maxLines) {
			truncatedBy = "lines";
			break;
		}
		const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(line);
		bytes += lineBytes;
	}

	return {
		content: kept.length > 0 ? `${kept.join("\n")}\n` : "",
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: kept.length,
	};
}

/**
 * Keep the last N lines/bytes. Suitable for bash output where the end of the
 * output (errors, summaries) matters most. If a single trailing line exceeds
 * the byte budget it is cut from its start (partial line edge case).
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLines(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines };
	}

	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] as string;
		if (kept.length >= maxLines) {
			truncatedBy = "lines";
			break;
		}
		const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
		if (bytes + lineBytes > maxBytes) {
			if (kept.length === 0) {
				// Single huge line: keep its tail so the newest bytes survive.
				const buf = Buffer.from(line, "utf-8");
				kept.push(buf.subarray(buf.length - maxBytes).toString("utf-8"));
			}
			truncatedBy = "bytes";
			break;
		}
		kept.unshift(line);
		bytes += lineBytes;
	}

	return {
		content: kept.length > 0 ? `${kept.join("\n")}\n` : "",
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: kept.length,
	};
}

/** Standard truncation notice appended to tool output. */
export function truncationNotice(result: TruncationResult, hint?: string): string {
	if (!result.truncated) return "";
	const base = `[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.totalBytes)} total).`;
	return hint ? `${base} ${hint}]` : `${base}]`;
}
