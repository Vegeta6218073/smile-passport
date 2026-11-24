import { describe, expect, it } from 'vitest';
import { ALL_ROLES, can, isRole, medicalWritable, navFor } from './roles';

describe('roles', () => {
  it('knows the four roles', () => {
    expect(ALL_ROLES).toEqual(['owner', 'doctor', 'coordinator', 'front_desk']);
  });

  it('accepts valid roles and rejects others', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('admin')).toBe(false);
    expect(isRole(null)).toBe(false);
  });

  it('gives every role the Today view', () => {
    for (const role of ALL_ROLES) {
      expect(navFor(role).some((item) => item.href === '/today')).toBe(true);
    }
  });

  it('keeps clinical data away from front desk', () => {
    expect(can('front_desk', 'patient:medical')).toBe(false);
    expect(can('front_desk', 'treatment:write')).toBe(false);
    expect(can('front_desk', 'sop:write')).toBe(false);
    expect(can('front_desk', 'patient:write')).toBe(true);
    expect(can('front_desk', 'appointment:write')).toBe(true);
  });

  it('lets only owner and doctor write medical records and SOPs', () => {
    expect(medicalWritable('doctor')).toBe(true);
    expect(medicalWritable('coordinator')).toBe(false);
    expect(can('coordinator', 'sop:write')).toBe(false);
    expect(can('doctor', 'sop:write')).toBe(true);
  });

  it('keeps Smile Passport scans away from front desk', () => {
    expect(can('front_desk', 'scan:view')).toBe(false);
    expect(can('coordinator', 'scan:view')).toBe(true);
    expect(can('coordinator', 'scan:report')).toBe(false);
    expect(can('doctor', 'scan:report')).toBe(true);
    expect(navFor('front_desk').some((i) => i.href === '/scans')).toBe(false);
  });

  it('shows the funnel to owner and coordinator only', () => {
    expect(can('owner', 'funnel:view')).toBe(true);
    expect(can('coordinator', 'funnel:view')).toBe(true);
    expect(can('doctor', 'funnel:view')).toBe(false);
  });

  it('lets only the owner manage clinic settings and the team', () => {
    expect(can('owner', 'settings:manage')).toBe(true);
    expect(can('coordinator', 'settings:manage')).toBe(false);
    expect(can('coordinator', 'template:write')).toBe(true);
    expect(navFor('doctor').some((i) => i.href === '/settings')).toBe(false);
  });
});
