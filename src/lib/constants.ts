export const LEAD_SOURCES = [
  ['google_search_maps', 'Google Search / Maps'],
  ['instagram', 'Instagram'],
  ['facebook_instagram_ad', 'Facebook / Instagram ad'],
  ['whatsapp_click_to_chat', 'WhatsApp click-to-chat'],
  ['patient_referral', 'Patient referral'],
  ['doctor_referral', 'Doctor referral'],
  ['walk_in_signboard', 'Walk-in / signboard'],
  ['website', 'Website'],
  ['other', 'Other'],
] as const;

export const CHANNELS = [
  ['whatsapp', 'WhatsApp'],
  ['call', 'Call'],
  ['walk_in', 'Walk-in'],
  ['web_form', 'Web form'],
] as const;

export const VISIT_TYPES = [
  ['new', 'New'],
  ['follow_up', 'Follow-up'],
  ['walkin', 'Walk-in'],
  ['emergency', 'Emergency'],
] as const;

export const LANGUAGES = [
  ['en', 'English'],
  ['hi', 'Hindi'],
  ['or', 'Odia'],
] as const;

export const RECALL_REASONS = [
  'Cost', 'Moved away', 'Too busy', 'Switched clinic', 'Unhappy with treatment', 'Could not reach', 'Other',
];
