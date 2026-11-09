import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { ADVISOR_GOAL_BANDS } from '../../src/lib/commissions/goal-engine.ts';

const { renderAdvisorPage } = createRequire(import.meta.url)('./helpers/advisor-page-fixture.cjs');

function bandRoute(html: string) {
  const start = html.indexOf('aria-label="Ruta de niveles"');
  assert.ok(start >= 0, 'The real advisor page must render its published level route');
  return html.slice(start, html.indexOf('Explora tus indicadores', start));
}

test('each advisor level displays its label, minimum points and commission in the mobile route', async () => {
  const { html } = await renderAdvisorPage('sales', 'goal');
  const route = bandRoute(html);
  for (const band of ADVISOR_GOAL_BANDS) {
    const namePosition = route.indexOf(`>${band.label}</span>`);
    assert.ok(namePosition >= 0);
    const entry = route.slice(namePosition, route.indexOf('</div>', namePosition));
    assert.match(entry, new RegExp(`aria-label="Desde ${band.minPoints} puntos"`));
    assert.match(entry, new RegExp(`>${band.minPoints} pts</span>`));
    assert.match(entry, new RegExp(`>${band.commissionPct}%</span>`));
  }
  assert.match(route, /grid-cols-5/);
});

test('administrator changes are displayed from period configuration, not hardcoded thresholds', async () => {
  const bands = ADVISOR_GOAL_BANDS.map((band, index) => ({ ...band, minPoints: index === 0 ? 0 : index * 75 }));
  const { html } = await renderAdvisorPage('sales', 'goal', { bands });
  const route = bandRoute(html);
  for (const minimum of [0, 75, 150, 225, 300]) assert.match(route, new RegExp(`>${minimum} pts</span>`));
  assert.doesNotMatch(route, />140 pts<|>170 pts<|>200 pts<|>240 pts</);
});

test('decimal point requirements remain readable without rounding them to a lower integer', async () => {
  const bands = ADVISOR_GOAL_BANDS.map((band) => ({ ...band, minPoints: band.minPoints === 140 ? 140.125 : band.minPoints }));
  const route = bandRoute((await renderAdvisorPage('sales', 'goal', { bands })).html);
  assert.match(route, /aria-label="Desde 140\.125 puntos"/);
  assert.match(route, />140,125 pts</);
});

test('unpublished goals are not exposed by the new points display', async () => {
  const { html } = await renderAdvisorPage('sales');
  assert.doesNotMatch(html, /aria-label="Ruta de niveles"|aria-label="Desde \d+ puntos"/);
});
