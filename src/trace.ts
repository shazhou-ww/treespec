/**
 * treespec — JSONL trace writer for run output
 *
 * Line types:
 *   meta:    { type, name, started_at, total_nodes, base_image? }
 *   step:    { type, index, node_path, command, stdout, stderr, exit_code, verdict, reason, duration_ms }
 *   summary: { type, total, passed, failed, skipped, duration_ms, ended_at }
 */

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type TraceMeta = {
	type: 'meta';
	name: string;
	started_at: string;
	total_nodes: number;
	base_image?: string;
};

export type TraceStep = {
	type: 'step';
	index: number;
	node_path: string;
	command: string;
	stdout: string;
	stderr: string;
	exit_code: number;
	verdict: string;
	reason: string;
	duration_ms: number;
	/** @deprecated alias of index — accepted on write for compatibility */
	step_index?: number;
};

export type TraceSummary = {
	type: 'summary';
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	duration_ms: number;
	ended_at: string;
};

export type TraceLine = TraceMeta | TraceStep | TraceSummary;

export interface TraceWriter {
	writeMeta(totalNodes: number, opts?: { name?: string; base_image?: string }): Promise<void>;
	writeStep(step: {
		index?: number;
		step_index?: number;
		node_path: string;
		command: string;
		stdout: string;
		stderr: string;
		exit_code: number;
		verdict: string;
		reason: string;
		duration_ms: number;
	}): Promise<void>;
	writeSummary(summary: Omit<TraceSummary, 'type'>): Promise<void>;
	readonly outputDir: string;
	readonly filePath: string | null;
}

class NullTraceWriter implements TraceWriter {
	readonly outputDir: string;
	readonly filePath = null;

	constructor(outputDir: string) {
		this.outputDir = outputDir;
	}

	async writeMeta(
		_totalNodes: number,
		_opts?: { name?: string; base_image?: string },
	): Promise<void> {}
	async writeStep(_step: {
		index?: number;
		step_index?: number;
		node_path: string;
		command: string;
		stdout: string;
		stderr: string;
		exit_code: number;
		verdict: string;
		reason: string;
		duration_ms: number;
	}): Promise<void> {}
	async writeSummary(_summary: Omit<TraceSummary, 'type'>): Promise<void> {}
}

class FileTraceWriter implements TraceWriter {
	readonly outputDir: string;
	readonly filePath: string;

	constructor(outputDir: string, filePath: string) {
		this.outputDir = outputDir;
		this.filePath = filePath;
	}

	private async append(line: TraceLine): Promise<void> {
		await appendFile(this.filePath, `${JSON.stringify(line)}\n`, 'utf8');
	}

	async writeMeta(
		totalNodes: number,
		opts?: { name?: string; base_image?: string },
	): Promise<void> {
		await this.append({
			type: 'meta',
			name: opts?.name ?? 'treespec run',
			started_at: new Date().toISOString(),
			total_nodes: totalNodes,
			base_image: opts?.base_image,
		});
	}

	async writeStep(step: {
		index?: number;
		step_index?: number;
		node_path: string;
		command: string;
		stdout: string;
		stderr: string;
		exit_code: number;
		verdict: string;
		reason: string;
		duration_ms: number;
	}): Promise<void> {
		const index = step.index ?? step.step_index ?? 0;
		await this.append({
			type: 'step',
			index,
			node_path: step.node_path,
			command: step.command,
			stdout: step.stdout,
			stderr: step.stderr,
			exit_code: step.exit_code,
			verdict: step.verdict,
			reason: step.reason,
			duration_ms: step.duration_ms,
		});
	}

	async writeSummary(summary: Omit<TraceSummary, 'type'>): Promise<void> {
		await this.append({
			type: 'summary',
			total: summary.total,
			passed: summary.passed,
			failed: summary.failed,
			skipped: summary.skipped,
			duration_ms: summary.duration_ms,
			ended_at: summary.ended_at,
		});
	}
}

/**
 * Generate a timestamped trace filename.
 * Prefix defaults to "trace" when no suite name is provided.
 */
function timestampedTraceFilename(suiteName?: string): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const prefix = suiteName ?? 'trace';
	return `${prefix}-${ts}.jsonl`;
}

/**
 * Create a trace writer. When `writeTrace` is false, returns a no-op writer.
 *
 * `outputPath` can be:
 *   - A file path (ending in .jsonl) → used directly
 *   - A directory path → file written inside as <suiteName>-<timestamp>.jsonl
 *
 * `suiteName` is used as the filename prefix in directory mode.
 * Trace file: `<outputPath>` or `<outputPath>/<suiteName>-<timestamp>.jsonl`
 */
export async function createTraceWriter(
	outputPath: string,
	writeTrace: boolean,
	suiteName?: string,
): Promise<TraceWriter> {
	if (!writeTrace) {
		return new NullTraceWriter(outputPath);
	}

	let filePath: string;
	let outputDir: string;

	if (outputPath.endsWith('.jsonl')) {
		// User specified a file path — use it directly
		filePath = outputPath;
		outputDir = dirname(outputPath);
	} else {
		// Directory — generate timestamped filename inside
		outputDir = outputPath;
		filePath = join(outputDir, timestampedTraceFilename(suiteName));
	}

	await mkdir(outputDir, { recursive: true });
	await writeFile(filePath, '', 'utf8');
	return new FileTraceWriter(outputDir, filePath);
}
