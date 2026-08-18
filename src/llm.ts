/**
 * treespec — LLM judge (OpenAI-compatible /chat/completions)
 */

import type { LlmConfig } from './config.js';
import type { StepResult } from './steps.js';
import type { Spec, Step } from './types.js';

export interface LLMMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

const JUDGE_SYSTEM_PROMPT = `You are a test judge. You are given a test case steps and their results.
Your job: determine if the output meets the expected criteria.

Reply in this exact format:
VERDICT: PASS
REASON: <one sentence explanation>

Or:
VERDICT: FAIL
REASON: <one sentence explanation of what went wrong>

Be strict but fair. Only PASS when the output clearly meets the criteria.`;

function formatStepCommand(step: Step): string {
	return step.command;
}

function formatStepOutput(result: StepResult): string {
	const stderr = result.stderr;
	return stderr
		? `[exit: ${result.exit_code}]\nstdout:\n${result.stdout}\nstderr:\n${stderr}`
		: `[exit: ${result.exit_code}]\n${result.stdout}`;
}

/**
 * Call an OpenAI-compatible chat completions API.
 */
export async function callLlmApi(
	messages: LLMMessage[],
	config: LlmConfig,
): Promise<string> {
	const apiKey = config.api_key;
	if (!apiKey) {
		throw new Error('LLM API key not configured (TREESPEC_LLM_API_KEY)');
	}

	const baseUrl = config.base_url.replace(/\/+$/, '');
	const url = `${baseUrl}/chat/completions`;

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: config.model,
				messages,
				temperature: 0,
				max_tokens: 256,
			}),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`LLM network error: ${message}`);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
	}

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string | null } }>;
	};
	return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Assemble judge chat messages from the test case and step history.
 * `steps` defaults to `spec.steps` (use postcon steps when judging a postcon).
 */
export function assembleJudgeMessages(
	spec: Spec,
	stepResults: StepResult[],
	currentIndex: number,
	steps: Step[] = spec.steps,
): LLMMessage[] {
	const messages: LLMMessage[] = [
		{ role: 'system', content: JUDGE_SYSTEM_PROMPT },
		{
			role: 'user',
			content:
				`Test case: "${spec.description ?? '(no description)'}"\n\n` +
				`You previously executed the following test steps. ` +
				`Judge the latest step's output against its expected criteria.`,
		},
	];

	for (let i = 0; i < currentIndex; i++) {
		const step = steps[i]!;
		const result = stepResults[i]!;
		messages.push({
			role: 'user',
			content:
				`Step ${i + 1}:\n${formatStepCommand(step)}\n\n` +
				`Output:\n${formatStepOutput(result)}\n\n` +
				`VERDICT: PASS`,
		});
	}

	const currentStep = steps[currentIndex]!;
	const currentResult = stepResults[currentIndex]!;
	const criteria =
		currentStep.assert?.type === 'llm' ? currentStep.assert.prompt : '(no criteria)';

	messages.push({
		role: 'user',
		content:
			`Step ${currentIndex + 1}:\n${formatStepCommand(currentStep)}\n\n` +
			`Output:\n${formatStepOutput(currentResult)}\n\n` +
			`Criteria: ${criteria}\n\n` +
			`Judge PASS or FAIL, and give a reason.`,
	});

	return messages;
}

/**
 * Parse LLM judge response into verdict + reason.
 */
export function parseJudgeResponse(
	response: string,
): { verdict: 'PASS' | 'FAIL'; reason: string } {
	const verdictMatch = response.match(/VERDICT:\s*(PASS|FAIL)/i);
	const reasonMatch = response.match(/REASON:\s*(.+)/i);

	if (!verdictMatch) {
		return { verdict: 'FAIL', reason: 'LLM response could not be parsed' };
	}

	const verdict = verdictMatch[1]!.toUpperCase() as 'PASS' | 'FAIL';
	const reason = reasonMatch
		? reasonMatch[1]!.trim()
		: 'LLM response could not be parsed';

	return { verdict, reason };
}
