import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isPlayFollowUpDue, workflowPresentation } from '../../src/lib/crm/play-member-presentation.ts';

const contact = '2026-10-07T18:54:43Z';
const response = '2026-10-07T18:55:00Z';
const launch = '2026-10-07T19:00:00Z';

test('the existing advisor palette is preserved for every workflow state', () => {
  const expected = [
    ['pending', 'Pendiente', '#7E8799'],
    ['follow_up_scheduled', 'Seguimiento', '#F0D000'],
    ['accepted', 'Aceptó', '#7CE0A9'],
    ['converted', 'Recompra', '#35E293'],
    ['not_interested', 'No aceptó', '#F06B78'],
    ['unreachable', 'Sin respuesta', '#F5A65B'],
    ['not_applicable', 'No aplica', '#8B93A7'],
    ['closed', 'Cerrado', '#8B93A7'],
    ['removed', 'Retirado', '#F06B78'],
  ];
  for (const [status, label, color] of expected) {
    const result = workflowPresentation(status, false, 'available', null, null, null);
    assert.equal(result.label, label);
    assert.equal(result.dot, `bg-[${color}]`);
    assert.match(result.chip, /border-.* bg-.* text-/);
    assert.match(result.row, /^border-l-/);
  }
});

test('contact, response and proposal use the latest recorded milestone', () => {
  assert.equal(workflowPresentation('pending', false, 'available', contact, null, null).label, 'Contacto iniciado');
  const responded = workflowPresentation('contacted', false, 'available', contact, response, null);
  assert.equal(responded.label, 'Respondió saludo');
  assert.equal(responded.dot, 'bg-[#B694FF]');
  assert.equal(workflowPresentation('responded', false, 'available', contact, response, launch).label, 'Jugada lanzada');
});

test('delivery and reservation take precedence over follow-up and earlier milestones', () => {
  const redeemed = workflowPresentation('responded', true, 'redeemed', contact, response, launch);
  assert.equal(redeemed.label, 'Obsequio entregado');
  assert.equal(redeemed.dot, 'bg-[#35E293]');
  const reserved = workflowPresentation('accepted', true, 'reserved', contact, response, launch);
  assert.equal(reserved.label, 'Obsequio reservado');
  assert.equal(reserved.dot, 'bg-[#F0D000]');
  assert.equal(workflowPresentation('accepted', true, 'available', contact, response, launch).label, 'Vencido');
});

test('a removed client stays retired even with previous contact, response or proposal', () => {
  assert.equal(workflowPresentation('removed', false, 'cancelled', contact, response, launch).label, 'Retirado');
  assert.equal(workflowPresentation('unknown', false, 'available', null, null, null).label, 'Pendiente');
});

test('follow-up deadline parsing is identical for both views', () => {
  const now = new Date('2026-10-09T12:00:00Z').getTime();
  assert.equal(isPlayFollowUpDue('2026-10-09T08:00:00-04:00', now), true);
  assert.equal(isPlayFollowUpDue('2026-10-09T12:00:01Z', now), false);
  assert.equal(isPlayFollowUpDue('invalid', now), false);
  assert.equal(isPlayFollowUpDue(null, now), false);
});

test('administrator and advisor render from the same palette and live milestones', () => {
  const advisor = readFileSync('src/app/app/advisor/plays/page.tsx', 'utf8');
  const admin = readFileSync('src/app/app/master/plays/MasterPlaysClient.tsx', 'utf8');
  const loader = readFileSync('src/app/app/master/plays/page.tsx', 'utf8');
  for (const source of [advisor, admin]) {
    assert.match(source, /import .*workflowPresentation.*from '@\/lib\/crm\/play-member-presentation'/);
    assert.match(source, /presentation\.dot/);
    assert.match(source, /presentation\.chip/);
    assert.match(source, /presentation\.row/);
    assert.doesNotMatch(source, /function workflowPresentation/);
  }
  for (const field of ['contacted_at', 'responded_at', 'play_launched_at', 'next_follow_up_at']) {
    assert.match(loader, new RegExp(field));
  }
  assert.match(admin, /member\.contactedAt, member\.respondedAt, member\.playLaunchedAt/);
  assert.match(loader, /\.neq\('workflow_status', 'removed'\)/);
});
