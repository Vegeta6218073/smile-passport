// Creates a dev clinic and one user per role. LOCAL DEVELOPMENT ONLY.
// Run after `supabase db reset`:  npm run seed:dev
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
if (!/127\.0\.0\.1|localhost/.test(url)) {
  console.error('Refusing to seed a non-local database.');
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const PASSWORD = 'DevOnly-ChangeMe-123';
const roles = ['owner', 'doctor', 'coordinator', 'front_desk'];
let doctorUserId = null;

const { data: clinic, error: clinicError } = await admin
  .from('clinics')
  .insert({ name: 'Dev Dental Clinic', home_cities: ['vizag', 'visakhapatnam'], review_fee_inr: 999 })
  .select('id')
  .single();
if (clinicError) throw clinicError;
console.log(`Add to .env.local:  SMILE_PASSPORT_CLINIC_ID=${clinic.id}`);

for (const role of roles) {
  const email = `${role.replace('_', '')}@dev.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const { error: memberError } = await admin
    .from('clinic_members')
    .insert({ clinic_id: clinic.id, user_id: data.user.id, role, display_name: `Dev ${role.replace('_', ' ')}` });
  if (memberError) throw memberError;
  if (role === 'doctor') doctorUserId = data.user.id;
  console.log(`created ${email} (${role})`);
}

const dummyPatients = [
  {
    full_name: 'Aarav Sharma',
    phone: '9876543210',
    email: 'aarav.sharma@example.com',
    dob: '1992-05-18',
    sex: 'Male',
    preferred_language: 'en',
    lead_source: 'walk_in_signboard',
    whatsapp_opt_in: true,
  },
  {
    full_name: 'Meera Nair',
    phone: '9876543211',
    email: 'meera.nair@example.com',
    dob: '1987-09-04',
    sex: 'Female',
    preferred_language: 'en',
    lead_source: 'patient_referral',
    whatsapp_opt_in: true,
  },
  {
    full_name: 'Kabir Reddy',
    phone: '9876543212',
    email: null,
    dob: '2012-03-22',
    sex: 'Male',
    preferred_language: 'te',
    guardian_name: 'Sanjay Reddy',
    guardian_phone: '9876543222',
    lead_source: 'instagram',
    whatsapp_opt_in: false,
  },
  {
    full_name: 'Ishita Das',
    phone: '9876543213',
    email: 'ishita.das@example.com',
    dob: '1998-12-11',
    sex: 'Female',
    preferred_language: 'en',
    lead_source: 'google_search_maps',
    whatsapp_opt_in: true,
  },
  {
    full_name: 'Rohan Patel',
    phone: '9876543214',
    email: null,
    dob: '1978-07-30',
    sex: 'Male',
    preferred_language: 'hi',
    lead_source: 'doctor_referral',
    whatsapp_opt_in: false,
  },
  {
    full_name: 'Ananya Iyer',
    phone: '9876543215',
    email: 'ananya.iyer@example.com',
    dob: '2008-01-15',
    sex: 'Female',
    preferred_language: 'en',
    guardian_name: 'Lakshmi Iyer',
    guardian_phone: '9876543225',
    lead_source: 'whatsapp_click_to_chat',
    whatsapp_opt_in: true,
  },
];

const { data: patients, error: patientsError } = await admin
  .from('patients')
  .insert(dummyPatients.map((patient) => ({ clinic_id: clinic.id, ...patient })))
  .select('id, full_name');
if (patientsError) throw patientsError;

const consentRows = patients.map((patient) => ({
  clinic_id: clinic.id,
  patient_id: patient.id,
  kind: 'data_processing',
  text_version: 'dummy-v1',
  given_by: patient.full_name,
}));
const { error: consentError } = await admin.from('consents').insert(consentRows);
if (consentError) throw consentError;

const optedIn = patients.filter((_, index) => dummyPatients[index].whatsapp_opt_in);
if (optedIn.length > 0) {
  const { error: optError } = await admin.from('whatsapp_opt_events').insert(
    optedIn.map((patient) => ({
      clinic_id: clinic.id,
      patient_id: patient.id,
      event: 'opt_in',
      source: 'registration',
    })),
  );
  if (optError) throw optError;
}

const today = new Date();
const tomorrow = new Date(today);
tomorrow.setDate(today.getDate() + 1);
const nextWeek = new Date(today);
nextWeek.setDate(today.getDate() + 7);
const isoDay = (date) => date.toISOString().slice(0, 10);
const appointmentAt = (day, hour, minute, minutes) => {
  const startsAt = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`);
  const endsAt = new Date(startsAt.getTime() + minutes * 60 * 1000);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
};

const todayAppointment = appointmentAt(isoDay(today), 10, 30, 45);
const tomorrowAppointment = appointmentAt(isoDay(tomorrow), 11, 0, 30);
const nextWeekAppointment = appointmentAt(isoDay(nextWeek), 16, 0, 45);
const { error: appointmentsError } = await admin.from('appointments').insert([
  {
    clinic_id: clinic.id,
    patient_id: patients[0].id,
    doctor_id: doctorUserId,
    chair: 'Chair 1',
    starts_at: todayAppointment.startsAt,
    ends_at: todayAppointment.endsAt,
    status: 'booked',
    visit_type: 'follow_up',
  },
  {
    clinic_id: clinic.id,
    patient_id: patients[2].id,
    doctor_id: doctorUserId,
    chair: 'Chair 2',
    starts_at: tomorrowAppointment.startsAt,
    ends_at: tomorrowAppointment.endsAt,
    status: 'booked',
    visit_type: 'new',
  },
  {
    clinic_id: clinic.id,
    patient_id: patients[3].id,
    doctor_id: null,
    chair: 'Chair 1',
    starts_at: nextWeekAppointment.startsAt,
    ends_at: nextWeekAppointment.endsAt,
    status: 'booked',
    visit_type: 'walkin',
  },
]);
if (appointmentsError) throw appointmentsError;

console.log(`Created ${patients.length} dummy patients and 3 sample appointments.`);
console.log(`Password for all dev users: ${PASSWORD}`);
