import { z } from 'zod';
import { ApiError } from '../errors.js';

/**
 * Suggested replies to a comment on one of the Hearth apps' posts (Claude, Hearth+). The
 * comment, the post's text and the app's name go to Claude; nothing else about the account.
 */

export const DEFAULT_REPLY_MODEL = 'claude-sonnet-5-5';

const SUBMIT_TOOL = {
  name: 'submit_replies',
  description: 'Submit the reply options.',
  input_schema: {
    type: 'object',
    properties: { replies: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 500 } } },
    required: ['replies'],
  },
} as const;

const inputSchema = z.object({ replies: z.array(z.string().trim().min(1).max(1000)).min(1).max(3) });

export type ReplyContext = { appName: string; aboutApp?: string | null; platform: string; postText: string; comment: string; author: string; thread: string[] };

export function replySystemPrompt(): string {
  return [
    'You write replies to comments on the social media accounts of Hearth Software, a small studio that makes a family of iPhone apps (BigTable, Suffice, Sated, Caloma, Hearken and more), as Hearth.',
    'Write three short, different replies: warm, human and specific to what the person said. Never defensive or salesy.',
    'Match the platform: Instagram and Facebook replies are one or two sentences; a light emoji is fine where it fits.',
    'Don’t promise features, dates, refunds or fixes. For a bug or billing problem, thank them and ask them to email support from the app’s settings.',
    'If the comment is spam, abusive or off-topic, make the replies brief and neutral (or a polite thank-you).',
    'Answer only by calling submit_replies once. Write nothing else.',
  ].join('\n');
}

export function replyUserMessage(context: ReplyContext): string {
  const thread = context.thread.length ? `\nEarlier in the thread:\n${context.thread.map((line) => `- ${line}`).join('\n')}` : '';
  return `Account: ${context.appName}${context.aboutApp ? `\nThe post is about: ${context.aboutApp}` : ''}\nPlatform: ${context.platform}\nThe post: ${context.postText || '(no text)'}\n${thread}\nComment from ${context.author || 'someone'}: ${context.comment}`;
}

export async function suggestReplies(context: ReplyContext, options: { apiKey: string | undefined; model?: string | undefined; fetcher?: typeof fetch }): Promise<string[]> {
  if (!options.apiKey) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Reply suggestions are not configured');
  const fetcher = options.fetcher ?? fetch;
  const payload = {
    model: options.model ?? DEFAULT_REPLY_MODEL,
    max_tokens: 800,
    system: replySystemPrompt(),
    tools: [SUBMIT_TOOL],
    // Some models refuse a forced tool choice; the prompt asks for the call instead.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: replyUserMessage(context) }],
  };
  const response = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  }).catch(() => null);
  if (!response || !response.ok) {
    const body = response ? await response.json().catch(() => null) as { error?: { type?: string; message?: string } } | null : null;
    const detail = body?.error?.message ? ` (${response?.status} ${body.error.type ?? 'error'}: ${body.error.message.slice(0, 300)})` : '';
    throw new ApiError(502, 'UPSTREAM_FAILED', `Claude could not suggest replies${detail}`);
  }
  const reply = await response.json().catch(() => null) as { content?: { type: string; name?: string; input?: unknown }[] } | null;
  const block = reply?.content?.find((item) => item.type === 'tool_use' && item.name === SUBMIT_TOOL.name);
  const parsed = inputSchema.safeParse(block?.input);
  if (!parsed.success) throw new ApiError(502, 'UPSTREAM_FAILED', 'Claude answered out of shape');
  return parsed.data.replies;
}
