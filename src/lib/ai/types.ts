// AI platform contracts (roadmap #17). A provider only ever sees minimised input: no names,
// phone numbers or addresses. Every result is a draft or a suggestion that a person reviews.

export type AiFeature = 'enquiry_reply' | 'checkin_classification' | 'plan_explainer' | 'weekly_summary';

export const AI_FEATURES: [AiFeature, string][] = [
  ['enquiry_reply', 'Draft replies to enquiries'],
  ['checkin_classification', 'Sort check-in replies by urgency'],
  ['plan_explainer', 'Draft plain-language plan explainers'],
  ['weekly_summary', 'Owner weekly summary'],
];

export type ReplyLabel = 'fine' | 'mild' | 'urgent' | 'unknown';
export type Classification = { label: ReplyLabel; topic: string | null; confidence: number };

export type Faq = { question: string; answer: string; keywords: string[] };
export type PriceRange = { treatment: string; min_inr: number; max_inr: number; note?: string | null };

export type EnquiryDraftInput = {
  question: string;            // already redacted
  language: string;            // patient's language code
  clinicName: string;
  faqs: Faq[];
  prices: PriceRange[];
  slots: string[];             // human-readable open slots, e.g. "Tue 3 Dec, 11:00 am"
};

export type PlanExplainerInput = {
  language: string;
  title: string;
  options: string | null;
  durationMonths: number | null;
  costInr: number | null;
  instalments: number | null;
};

export type Metric = { key: string; label: string; current: number; previous: number; better: 'up' | 'down'; href: string; unit?: string };

export type Draft = {
  text: string;                // may contain {{name}}, filled in after the provider call
  grounded: boolean;           // false when no approved content matched: staff must check it
  handover: boolean;           // true when the provider cannot help (e.g. unsupported language)
  confidence: number;
  sources: string[];           // what the draft is based on, shown to staff
};

export type SummaryLine = { text: string; href: string; tone: 'good' | 'bad' | 'neutral' };

export interface AiProvider {
  name: string;
  classifyReply(text: string): Promise<Classification>;
  draftEnquiryReply(input: EnquiryDraftInput): Promise<Draft>;
  explainPlan(input: PlanExplainerInput): Promise<Draft>;
  summariseWeek(metrics: Metric[]): Promise<SummaryLine[]>;
}
