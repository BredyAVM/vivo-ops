import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPlayMessage } from '../../src/lib/crm/play-message.ts';

const values = {
  clientName: 'Gloria',
  advisorName: 'Yujani',
  benefitLabel: 'Single Pack de 6',
  validityLabel: 'antes del 30 de septiembre',
};

test('personalizes bracket placeholders used by the commercial scripts', () => {
  assert.equal(
    renderPlayMessage('Epa [Nombre], tienes [Beneficio]. Te atiende [Asesor] [Vigencia].', values),
    'Epa Gloria, tienes Single Pack de 6. Te atiende Yujani antes del 30 de septiembre.',
  );
});

test('keeps compatibility with brace placeholders regardless of capitalization', () => {
  assert.equal(
    renderPlayMessage('{NOMBRE}: {BENEFICIO} · {ASESOR} · {VIGENCIA}', values),
    'Gloria: Single Pack de 6 · Yujani · antes del 30 de septiembre',
  );
});

test('leaves unrelated text untouched and replaces repeated placeholders', () => {
  assert.equal(
    renderPlayMessage('[Nombre], gracias [nombre] 💛', values),
    'Gloria, gracias Gloria 💛',
  );
});
