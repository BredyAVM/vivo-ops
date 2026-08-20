import assert from 'node:assert/strict';
import test from 'node:test';
import { selectEligibleCommissionAdvisors } from '../../src/lib/commissions/advisor-eligibility.ts';

const advisorProfiles = [
  { user_id: 'advisor-1', full_name: 'Asesor activo', is_active: true },
  { user_id: 'advisor-2', full_name: 'Administrador vendedor', is_active: true },
  { user_id: 'advisor-3', full_name: 'Asesor inactivo', is_active: false },
];

const commissionProfiles = [
  { id: 'advisor-1', full_name: 'Asesor activo', is_active: true, receives_commissions: true },
  { id: 'advisor-2', full_name: 'Administrador vendedor', is_active: true, receives_commissions: false },
  { id: 'advisor-3', full_name: 'Asesor inactivo', is_active: false, receives_commissions: true },
];

test('separa acceso de asesor de participación en comisiones', () => {
  assert.deepEqual(
    selectEligibleCommissionAdvisors({ advisorProfiles, commissionProfiles }),
    [{ userId: 'advisor-1', fullName: 'Asesor activo' }]
  );
});

test('rechaza el cálculo individual de un asesor sin comisiones', () => {
  assert.deepEqual(
    selectEligibleCommissionAdvisors({
      advisorProfiles,
      commissionProfiles,
      advisorUserId: 'advisor-2',
    }),
    []
  );
});
