export type Role = 'owner' | 'doctor' | 'coordinator' | 'front_desk';

export const ALL_ROLES: Role[] = ['owner', 'doctor', 'coordinator', 'front_desk'];

// UI-level permissions. These only decide what to show: the database role matrix in
// supabase/migrations/*.sql is the real enforcement, and must be kept in step with this.
export type Permission =
  | 'patient:write'
  | 'patient:medical'
  | 'appointment:write'
  | 'treatment:write'
  | 'sop:write'
  | 'enquiry:write'
  | 'task:assign_any'
  | 'template:write'
  | 'scan:view'
  | 'scan:report'
  | 'funnel:view'
  | 'settings:manage';

const MATRIX: Record<Permission, Role[]> = {
  'patient:write': ALL_ROLES,
  'patient:medical': ['owner', 'doctor', 'coordinator'], // coordinator reads only; see medicalWritable()
  'appointment:write': ALL_ROLES,
  'treatment:write': ['owner', 'doctor', 'coordinator'],
  'sop:write': ['owner', 'doctor'],
  'enquiry:write': ALL_ROLES,
  'task:assign_any': ['owner', 'coordinator'],
  'template:write': ['owner', 'coordinator'],
  'scan:view': ['owner', 'doctor', 'coordinator'],
  'scan:report': ['owner', 'doctor'],
  'funnel:view': ['owner', 'coordinator'],
  'settings:manage': ['owner'],
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[permission].includes(role);
}

export function medicalWritable(role: Role): boolean {
  return role === 'owner' || role === 'doctor';
}

export type NavItem = { href: string; label: string; roles: Role[] };

export const NAV: NavItem[] = [
  { href: '/today', label: 'Today', roles: ALL_ROLES },
  { href: '/patients', label: 'Patients', roles: ALL_ROLES },
  { href: '/appointments', label: 'Appointments', roles: ALL_ROLES },
  { href: '/scans', label: 'Smile scans', roles: ['owner', 'doctor', 'coordinator'] },
  { href: '/funnel', label: 'Funnel', roles: ['owner', 'coordinator'] },
  { href: '/enquiries', label: 'Enquiries', roles: ALL_ROLES },
  { href: '/tasks', label: 'Tasks', roles: ALL_ROLES },
  { href: '/sops', label: 'SOPs', roles: ALL_ROLES },
  { href: '/settings', label: 'Settings', roles: ['owner', 'coordinator'] },
  { href: '/security', label: 'Security', roles: ALL_ROLES },
];

export function navFor(role: Role): NavItem[] {
  return NAV.filter((item) => item.roles.includes(role));
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ALL_ROLES as string[]).includes(value);
}
