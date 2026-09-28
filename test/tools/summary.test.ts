import { afterEach, expect, it } from 'vitest';
import * as d from '../../src/db/index.js';
import { displayDate, escapeHtml, telegramChunks, toPlainText, toTelegramHtml, type Summary } from '../../src/tools/summary.js';
import { runTool, confirmProposal } from '../../src/tools/index.js';
import { fixture, expense, expenseArgs, prepare, now, type Fixture } from '../agent/helpers.js';
const opened:Fixture[]=[];
const make=()=>{const f=fixture();opened.push(f);return f;};
afterEach(()=>opened.splice(0).forEach(f=>f.db.close()));

it('escapes every user-controlled field while keeping plain text untouched',async()=>{
  const f=make();
  d.addManualMember(f.db,f.scope,'<Alex & Sam>');
  const {plans,p}=await prepare(f,'add_expense',{...expenseArgs,description:'<b>Tom & Jerry</b>',merchant:'<Cafe>',splitType:'items',items:[{label:'<food & drink>',amount:'12',people:[{name:'<Alex & Sam>'}]}]});
  const summary=plans[0]!.structuredSummary;
  const html=toTelegramHtml(summary);
  expect(html).toContain('<b>➕ Add &lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</b>');
  expect(html).toContain('Merchant: &lt;Cafe&gt;');
  expect(html).toContain('• &lt;Alex &amp; Sam&gt;: 12.00 SGD');
  expect(html).toContain('• &lt;food &amp; drink&gt; · 12.00 SGD: &lt;Alex &amp; Sam&gt;');
  expect(html).toContain('<b>Each pays</b>');
  expect(p.summary).toBe(toPlainText(summary));
  expect(p.summary).toContain('<b>Tom & Jerry</b>');
});
it('packs whole blocks and splits oversized blocks without losing lines or breaking tags or entities',()=>{
  const s:Summary={icon:'✏️',title:'Change <b>Tom & Jerry</b>',blocks:[{lines:['Paid by Sam']},{heading:'Items',lines:Array.from({length:500},(_,i)=>({bullet:`${i} ${'<🍜&>'.repeat(30)}`}))}]};
  const chunks=telegramChunks(s);
  expect(chunks.length).toBeGreaterThan(1);
  for(const chunk of chunks){
    expect(chunk.length).toBeLessThan(4096);
    expect(new TextDecoder().decode(new TextEncoder().encode(chunk))===chunk).toBe(true);
    expect(chunk.replace(/<b>[^<>]*<\/b>/g,'')).not.toMatch(/[<>]/);
    expect(chunk.replace(/&(amp|lt|gt);/g,'')).not.toContain('&');
  }
  expect(chunks[0]).toContain('<b>✏️ Change &lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</b>\n\nPaid by Sam');
  expect(chunks.join('\n\n').replace(/\n+/g,'\n')).toBe(toTelegramHtml(s).replace(/\n+/g,'\n'));
});
it('also bounds a single very long line without breaking Unicode or an escaped character',()=>{
  const title='<&🍜>'.repeat(2000);
  const chunks=telegramChunks({icon:'',title,blocks:[]});
  expect(chunks.every(c=>c.length<=4000&&c.startsWith('<b>')&&c.endsWith('</b>')&&new TextDecoder().decode(new TextEncoder().encode(c))===c)).toBe(true);
  expect(chunks.map(c=>c.slice(3,-4)).join('')).toBe(escapeHtml(title));
});
it('shows only the changed payer and the unchanged shares',async()=>{
  const f=make(),e=expense(f);
  const {p,plans}=await prepare(f,'edit_expense',{expenseId:e.id,changes:{payer:'Alex'}});
  expect(p.summary).toBe('✏️ Change Taxi\n\nPaid by: you → Alex\n\nEach pays\n• Sam: 6.00 SGD\n• Alex: 6.00 SGD');
  expect(toTelegramHtml(plans[0]!.structuredSummary)).toBe('<b>✏️ Change Taxi</b>\n\nPaid by: you → Alex\n\n<b>Each pays</b>\n• Sam: 6.00 SGD\n• Alex: 6.00 SGD');
  const result=confirmProposal(f.db,{}, {proposalId:p.id,memberId:f.member.id,now});
  expect(result).toMatchObject({kind:'done',notices:[{method:'expenseEdited',payload:{changes:['Paid by: Sam → Alex']}}]});
});
it('refuses no-op edits and expense rates without writing a proposal',async()=>{
  const f=make(),e=expense(f,'confirmed',{currency:'JPY',total:1200,rateOverride:'100'});
  for(const changes of [{},{payer:'Sam'},{amount:'1200'},{people:[{name:'Alex'},{name:'Sam'}]}])
    await expect(runTool(f.context,'edit_expense',{expenseId:e.id,changes})).rejects.toThrow("That's already how it is.");
  await expect(runTool(f.context,'set_expense_rate',{expenseId:e.id,rate:'100'})).rejects.toThrow("That's already how it is.");
  expect(f.db.prepare('SELECT * FROM agent_proposal').all()).toEqual([]);
});
it('shows changed shares with the old amounts and only non-zero extras on a new expense',async()=>{
  const f=make(),e=expense(f);
  const {p}=await prepare(f,'edit_expense',{expenseId:e.id,changes:{amount:'16'}});
  expect(p.summary).toBe('✏️ Change Taxi\n\nTotal: 12.00 → 16.00 SGD\n\nEach pays\n• Sam: 6.00 → 8.00 SGD\n• Alex: 6.00 → 8.00 SGD');
  const result=await runTool(f.context,'add_expense',{...expenseArgs,tax:'1',taxIncluded:true,tip:'2'});
  expect(result.kind).toBe('proposal');if(result.kind!=='proposal')return;
  expect(result.plans[0]!.summary).toContain('Tax: 1.00 SGD (in the prices)\nTip: 2.00 SGD');
  expect(result.plans[0]!.summary).not.toMatch(/Discount|Service charge/);
});
it('renders zero-decimal foreign items, quantities, assignments and foundation home amounts',async()=>{
  const f=make();d.setTripRate(f.db,f.scope,f.trip.id,'JPY','100','member');
  const {p}=await prepare(f,'add_expense',{...expenseArgs,description:'Yakitori',currency:'JPY',amount:'1200',splitType:'items',items:[{label:'Set',quantity:2,amount:'900',people:[{name:'Sam'},{name:'Alex',weight:2}]},{label:'Tea',amount:'300'}]});
  expect(p.summary).toBe('➕ Add Yakitori\n\nTotal: 1,200 JPY (≈ 12.00 SGD)\nPaid by you\nDate: Mon 28 Sep\nSplit by item\nRate: 1 SGD = 100 JPY · trip rate\n\nEach pays\n• Sam: 450 JPY (≈ 4.50 SGD)\n• Alex: 750 JPY (≈ 7.50 SGD)\n\nItems\n• Set ×2 · 900 JPY: Sam, Alex ×2\n• Tea · 300 JPY: everyone');
});
it('formats Singapore dates with a year only outside the current Singapore year',()=>{
  const at=new Date('2026-12-31T16:00:00Z');
  expect(displayDate('2027-01-01',at)).toBe('Fri 1 Jan');
  expect(displayDate('2026-09-28',at)).toBe('Mon 28 Sep 2026');
});
it('approves an unchanged draft in full and a changed draft with only its changes',async()=>{
  const f=make(),e=expense(f,'draft');
  const result=await runTool(f.context,'approve_draft',{expenseId:e.id,changes:{payer:'Alex'}});
  expect(result.kind).toBe('proposal');if(result.kind!=='proposal')return;
  expect(result.plans[0]!.summary).toBe('✅ Approve Taxi\n\nPaid by: you → Alex\n\nEach pays\n• Sam: 6.00 SGD\n• Alex: 6.00 SGD');
});
it('renders several actions in order with one overall title and separate action headings',async()=>{
  const f=make();
  const { createAgentProposal, proposalVersions, proposalSummary }=await import('../../src/tools/index.js');
  const first=await runTool(f.context,'add_expense',expenseArgs);
  const second=await runTool(f.context,'add_member',{name:'Dev'});
  const third=await runTool(f.context,'rename_trip',{name:'Tokyo'});
  if(first.kind!=='proposal'||second.kind!=='proposal'||third.kind!=='proposal')throw new Error('Expected plans');
  const plans=[...first.plans,...second.plans,...third.plans];
  const p=createAgentProposal(f.db,f.scope,{plans,versions:proposalVersions(f.db,f.scope),chatId:-100,now});
  expect(p.summary).toBe('3 changes\n\n➕ Add Taxi\n\nTotal: 12.00 SGD\nPaid by you\nDate: Mon 28 Sep\nSplit equally between 2\n\nEach pays\n• Sam: 6.00 SGD\n• Alex: 6.00 SGD\n\n👤 Add person Dev\n\nThey will be included in future everyone splits.\n\n✏️ Rename trip Holiday\n\nName: Holiday → Tokyo');
  expect(toTelegramHtml(proposalSummary(plans))).toContain('<b>3 changes</b>\n\n<b>➕ Add Taxi</b>');
});
it('compares assignments by identity, including people with the same display name',async()=>{
  const f=make(),e=expense(f),other=d.addManualMember(f.db,f.scope,'Alex');
  const { expenseChanges }=await import('../../src/tools/tools/expensePlan.js');
  const { inputOf }=await import('../../src/tools/tools/shared.js');
  const before=d.saveExpense(f.db,f.scope,e.id,e.version,{...inputOf(e),payerId:f.alex.id});
  expect(expenseChanges(f.context,before,{...inputOf(before),payerId:other.id},before.fxRate,before.fxRateSource)).toEqual([{label:'Paid by',before:'Alex',after:'Alex'}]);
});
it('does not call an older saved suggested trip rate looked up today',async()=>{
  const f=make();d.setTripRate(f.db,f.scope,f.trip.id,'JPY','100','suggested');
  const {p}=await prepare(f,'add_expense',{...expenseArgs,currency:'JPY',amount:'1200'});
  expect(p.summary).toContain('Rate: 1 SGD = 100 JPY · trip rate');
  expect(p.summary).not.toContain('looked up today');
});
it('puts only changed items on separate lines and includes home amounts on foreign total edits',async()=>{
  const f=make();d.setTripRate(f.db,f.scope,f.trip.id,'JPY','100','member');
  const e=expense(f,'confirmed',{currency:'JPY',total:1200,splitType:'items',items:[{label:'Food',amount:900},{label:'Tea',amount:300}]});
  const {p}=await prepare(f,'edit_expense',{expenseId:e.id,changes:{amount:'1500',items:[{label:'Food',amount:'1200'},{label:'Tea',amount:'300'}]}});
  expect(p.summary).toContain('Total: 1,200 JPY (≈ 12.00 SGD) → 1,500 JPY (≈ 15.00 SGD)');
  expect(p.summary).toContain('Who had what\n• Food · 900 JPY → Food · 1,200 JPY: everyone');
  expect(p.summary).not.toContain('Tea');
});
