// The default AI provider: transparent rules, no network, no patient data leaves S-One.
// It is the baseline any model provider must beat on the clinician-labelled test sets, and the
// fallback whenever a model provider is switched off. Languages: English and Hindi/Hinglish
// (Latin and Devanagari). Anything else returns "unknown" or a handover, so a person handles it.
import type {
  AiProvider, Classification, Draft, EnquiryDraftInput, Metric, PlanExplainerInput, SummaryLine,
} from './types';

export const RULES_MODEL = 'rules-v1';

const has = (text: string, patterns: RegExp[]) => patterns.some((p) => p.test(text));

// Order matters: negated phrases ("no pain") count as fine before "pain" counts as mild.
const FINE_NEGATED = [
  /\bno (pain|problem|issue|issues|trouble|discomfort)\b/, /\bnot (paining|hurting)\b/,
  /\b(dard|problem|takleef|dikkat) nahi\b/, /\bkoi (problem|dikkat|takleef) nahi\b/, /दर्द नहीं/, /कोई (दिक्कत|परेशानी) नहीं/,
];
const URGENT: [RegExp, string][] = [
  [/\bbleed(ing|s)?\b|\bblood\b|\bkhoon\b|खून/, 'bleeding'],
  [/\bswell(ing|ed|en)?\b|\bsujan\b|\bsoojan\b|सूजन/, 'swelling'],
  [/\bfever\b|\bbukhar\b|बुखार/, 'fever'],
  [/\b(severe|unbearable|terrible|very bad|extreme) (pain|ache)\b|\bbahut (zyada )?dard\b|बहुत दर्द/, 'pain'],
  [/\b(can'?t|cannot|unable to) (eat|chew|open|sleep)\b|\bkha nahi\b|खा नहीं/, 'eating'],
  [/\b(pus|infection|infected)\b/, 'infection'],
  [/\b(accident|injur(y|ed)|fell|hit)\b/, 'injury'],
  [/\b(cut|cutting|poking|piercing)\b.*\b(cheek|gum|lip|tongue|mouth)\b|\b(cheek|gum|lip|tongue|mouth)\b.*\b(cut|cutting|poking|bleed)/, 'wire_injury'],
];
const MILD: [RegExp, string][] = [
  [/\b(pain|paining|ache|aching|hurts?|hurting|sore|discomfort|dard)\b|दर्द/, 'pain'],
  [/\b(broke|broken|came off|fell off|toot|tut gaya)\b|टूट/, 'broken_appliance'],
  [/\b(loose|wire|bracket|poking)\b/, 'loose_bracket_or_wire'],
  [/\b(ulcer|ulcers|sore spot|chhala|chhale)\b|छाले/, 'ulcer'],
  [/\b(tight|tightness|pressure)\b/, 'tightness'],
];
const FINE = [
  /^\s*(ok|okay|k|fine|good|great|all good|all ok|all fine|yes|yes fine|no|nope|nothing|👍|🙂|😊|thanks?|thank you)\s*[.!]*\s*$/,
  /\b(all good|doing (good|fine|well)|feeling (good|fine|better)|no problem|everything (is )?(fine|good|ok))\b/,
  /\b(theek|thik|badhiya|bhadiya|accha|achha|sab (theek|thik|badhiya))\b/, /ठीक|बढ़िया|अच्छा/,
  /\b(fine|ok|okay|good|better)\b/,
];
// "not fine", "theek nahi": something is wrong, but we cannot tell what.
const NOT_FINE = /\bnot (feeling )?(fine|ok|okay|good|well|better)\b|\b(theek|thik|accha) nahi\b|ठीक नहीं/;

export function classifyText(raw: string): Classification {
  const text = String(raw ?? '').toLowerCase().normalize('NFC');
  if (!text.trim()) return { label: 'unknown', topic: null, confidence: 0 };

  for (const [p, topic] of URGENT) if (p.test(text)) return { label: 'urgent', topic, confidence: 0.9 };

  if (NOT_FINE.test(text)) return { label: 'mild', topic: null, confidence: 0.5 };

  const negatedFine = has(text, FINE_NEGATED);
  const scrubbed = FINE_NEGATED.reduce((t, p) => t.replace(new RegExp(p.source, 'g'), ' '), text);
  const mild = MILD.find(([p]) => p.test(scrubbed));
  const fine = negatedFine || has(text, FINE);

  if (mild && fine) return { label: 'unknown', topic: mild[1], confidence: 0.4 };   // mixed signals: a person reads it
  if (mild) return { label: 'mild', topic: mild[1], confidence: 0.85 };
  if (fine) return { label: 'fine', topic: null, confidence: 0.9 };
  return { label: 'unknown', topic: null, confidence: 0.3 };
}

const STOP = new Set(('a an the is are am do does did i my me you your we our for to of in on at and or how much what when where ' +
  'can could will would it this that with be have has please kya hai ka ki ke mein hum aap').split(' '));
const tokens = (s: string) =>
  String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));

const SUPPORTED_DRAFT_LANGUAGES = new Set(['en']);

export function draftReply(input: EnquiryDraftInput): Draft {
  if (!SUPPORTED_DRAFT_LANGUAGES.has(input.language)) {
    return {
      text: '', grounded: false, handover: true, confidence: 0,
      sources: [`Drafts are not available in this language yet (${input.language}). Reply yourself.`],
    };
  }
  const q = new Set(tokens(input.question));
  const scored = input.faqs
    .map((f) => {
      const words = new Set([...tokens(f.question), ...f.keywords.flatMap(tokens)]);
      let score = 0;
      for (const w of q) if (words.has(w)) score += 1;
      return { f, score };
    })
    .filter((x) => x.score >= 2 || (x.score >= 1 && q.size <= 3))
    .sort((a, b) => b.score - a.score);
  const faq = scored[0]?.f;
  const price = input.prices.find((p) => tokens(p.treatment).some((t) => q.has(t) || q.has(`${t}s`) || q.has(t.replace(/s$/, ''))));

  const lines = [`Hi {{name}}, thank you for contacting ${input.clinicName}.`];
  const sources: string[] = [];
  if (faq) { lines.push(faq.answer.trim()); sources.push(`FAQ: ${faq.question}`); }
  if (price) {
    const range = price.min_inr === price.max_inr
      ? `about ₹${price.min_inr.toLocaleString('en-IN')}`
      : `₹${price.min_inr.toLocaleString('en-IN')} to ₹${price.max_inr.toLocaleString('en-IN')}`;
    lines.push(`${price.treatment} at our clinic usually costs ${range}. The exact cost depends on your case and is confirmed after an examination.`);
    sources.push(`Price range: ${price.treatment}`);
  }
  const grounded = sources.length > 0;
  if (!grounded) lines.push('A member of our team will answer your question shortly.');
  if (input.slots.length) {
    lines.push(`We have consultation times on ${input.slots.join(', or ')}. Would one of these suit you?`);
    sources.push('Open slots from the schedule');
  }
  return { text: lines.join(' '), grounded, handover: false, confidence: grounded ? 0.7 : 0.3, sources };
}

export function explainPlanText(input: PlanExplainerInput): Draft {
  if (!SUPPORTED_DRAFT_LANGUAGES.has(input.language)) {
    return { text: '', grounded: false, handover: true, confidence: 0,
      sources: [`Explainers are not available in this language yet (${input.language}). Write it yourself.`] };
  }
  const lines = [`Hi {{name}}, here is a simple summary of the treatment we discussed: ${input.title}.`];
  if (input.options?.trim()) lines.push(`What it involves: ${input.options.trim()}`);
  if (input.durationMonths) lines.push(`It usually takes about ${input.durationMonths} months, with regular visits so we can adjust and check progress.`);
  if (input.costInr) {
    lines.push(`The estimated cost is ₹${input.costInr.toLocaleString('en-IN')}` +
      (input.instalments && input.instalments > 1 ? `, which can be paid in ${input.instalments} instalments.` : '.'));
  }
  lines.push('Please ask us anything that is not clear. Nothing starts until you are comfortable and have signed the consent.');
  return { text: lines.join(' '), grounded: true, handover: false, confidence: 0.8, sources: ['Treatment plan fields'] };
}

export function summarise(metrics: Metric[]): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const m of metrics) {
    const diff = m.current - m.previous;
    const unit = m.unit ?? '';
    if (diff === 0) {
      lines.push({ text: `${m.label}: ${m.current}${unit}, the same as last week.`, href: m.href, tone: 'neutral' });
      continue;
    }
    const good = m.better === 'up' ? diff > 0 : diff < 0;
    const pct = m.previous > 0 ? ` (${diff > 0 ? '+' : ''}${Math.round((diff / m.previous) * 100)}%)` : '';
    lines.push({
      text: `${m.label} ${diff > 0 ? 'rose' : 'fell'} to ${m.current}${unit} from ${m.previous}${unit}${pct}.`,
      href: m.href,
      tone: good ? 'good' : 'bad',
    });
  }
  // What is slipping first, then good news, then the unchanged.
  const order = { bad: 0, good: 1, neutral: 2 } as const;
  return lines.sort((a, b) => order[a.tone] - order[b.tone]);
}

export const rulesProvider: AiProvider = {
  name: RULES_MODEL,
  classifyReply: async (text) => classifyText(text),
  draftEnquiryReply: async (input) => draftReply(input),
  explainPlan: async (input) => explainPlanText(input),
  summariseWeek: async (metrics) => summarise(metrics),
};
