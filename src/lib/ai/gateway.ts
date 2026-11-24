// The one gateway every AI call goes through (roadmap #17):
//  - per-clinic and per-feature off switches       - identifier minimisation before the provider
//  - provider abstraction (AI_PROVIDER)             - every action logged to ai_actions
//  - nothing is sent from here: drafts wait for a person (review_ai_draft)
// Server only. The provider is "rules" until a model provider is chosen with counsel (see
// docs/decisions/0002-ai-data-handling.md); adding one means one file implementing AiProvider.
import type { SupabaseClient } from '@supabase/supabase-js';
import { rulesProvider } from './rules';
import type { AiFeature, AiProvider } from './types';

export function getAiProvider(env: Record<string, string | undefined> = process.env): AiProvider {
  const name = env.AI_PROVIDER ?? 'rules';
  if (name === 'rules') return rulesProvider;
  throw new Error(`Unknown AI_PROVIDER "${name}". Only "rules" is available until a model provider is approved.`);
}

type Switches = { ai_enabled: boolean; ai_features: Record<string, boolean> | null };

export function featureOn(s: Switches | null | undefined, feature: AiFeature): boolean {
  return !!s?.ai_enabled && s.ai_features?.[feature] !== false;
}

export async function loadSwitches(db: SupabaseClient, clinicId: string): Promise<Switches | null> {
  const { data } = await db.from('clinics').select('ai_enabled, ai_features').eq('id', clinicId).maybeSingle();
  return data as Switches | null;
}

export type AiLog = {
  clinicId: string;
  feature: AiFeature;
  patientId?: string | null;
  subjectId?: string | null;
  inputRef: Record<string, unknown>;   // ids only, never copies of patient data
  draft: string;
  model: string;
  grounded?: boolean;
  confidence?: number;
};

// Written with the service role: staff cannot forge or edit AI records, only review them.
export async function logAiAction(admin: SupabaseClient, log: AiLog): Promise<string> {
  const { data, error } = await admin.from('ai_actions').insert({
    clinic_id: log.clinicId,
    feature: log.feature,
    patient_id: log.patientId ?? null,
    subject_id: log.subjectId ?? null,
    input_ref: log.inputRef,
    draft: log.draft,
    model: log.model,
    grounded: log.grounded ?? null,
    confidence: log.confidence ?? null,
  }).select('id').single();
  if (error || !data) throw new Error(`could not log AI action: ${error?.message ?? 'unknown'}`);
  return data.id as string;
}

// Outcome of a reviewed draft: unchanged, edited, or thrown away.
export function reviewOutcome(draft: string, finalText: string, discard: boolean): 'sent' | 'edited_sent' | 'discarded' {
  if (discard) return 'discarded';
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(draft) === norm(finalText) ? 'sent' : 'edited_sent';
}
