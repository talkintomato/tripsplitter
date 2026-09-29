import { expect, it } from 'vitest';
import { createOpenAIAgentModel } from '../../../src/agent/openai.js';
import { runAgentTurn } from '../../../src/agent/loop.js';
import { fixture, now } from '../helpers.js';

// Environment only; neither this config nor this test reads .env.
const key = process.env.OPENAI_API_KEY?.trim();
const cases = [
  ['Taxi 24 SGD today, I paid, split evenly between everyone.', 'add_expense'],
  ['Who owes what?', 'get_balances'],
  ['Alex paid me 12 SGD. Record the payment.', 'record_payment'],
  ['Show the recent expenses.', 'list_expenses'],
  ['Rename this trip to Japan holiday.', 'rename_trip'],
  // Nothing about who paid, when or who shares it: the defaults apply instead of a question.
  ['Breakfast 18', 'add_expense'],
  ['Lunch: noodles 9, iced tea 3 for Alex, dumplings 8', 'add_expense'],
] as const;
for (const [index, [sentence, expected]] of cases.entries()) {
  it.skipIf(!key)(`live sentence ${index + 1}: calls ${expected}`, async () => {
    const f = fixture();
    const tools: string[] = [];
    const real = createOpenAIAgentModel({ apiKey: key!, model: process.env.AGENT_MODEL?.trim() || 'gpt-6-luna' });
    try {
      const result = await runAgentTurn(f.db, f.config, {
        suggestRate: async () => null,
        model: { async respond(input) {
          const output = await real.respond(input);
          if (output.kind === 'tool_calls') tools.push(...output.calls.map(c => c.name));
          return output;
        } },
      }, { groupId: f.g.group.id, memberId: f.member.id, chatId: -100, text: sentence, now });
      // Report names/counts only, never messages, turns, arguments or provider error bodies.
      console.log(`Agent live case ${index + 1}: ${tools.length} calls: ${tools.join(', ') || '(none)'}`);
      expect(result.kind).not.toBe('unavailable');
      expect(tools).toContain(expected);
      if (expected === 'add_expense') expect(result.kind).toBe('proposal');
      expect(tools.length).toBeLessThanOrEqual(6);
    } finally { f.db.close(); }
  });
}
