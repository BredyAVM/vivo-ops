import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));

type LockedPackage = { version?: string; dev?: boolean };
const packages = Object.entries(lock.packages) as Array<[string, LockedPackage]>;

function stableVersion(version: string): number[] {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Use a stable, reviewed dependency version');
  return version.split('.').map(Number);
}

function atLeast(actual: string, minimum: string): boolean {
  const current = stableVersion(actual);
  const floor = stableVersion(minimum);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== floor[i]) return current[i] > floor[i];
  }
  return true;
}

function copies(name: string): Array<[string, LockedPackage]> {
  return packages.filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);
}

test('Next is pinned and the lockfile retains the reviewed security floor', () => {
  const version = manifest.dependencies.next;
  assert.ok(atLeast(version, '16.3.8'));
  assert.equal(lock.packages[''].dependencies.next, version);
  assert.equal(lock.packages['node_modules/next'].version, version);
});

test('the Next lint packages match the framework instead of downgrading to an incompatible audit fix', () => {
  const version = manifest.dependencies.next;
  assert.equal(manifest.devDependencies['eslint-config-next'], version);
  assert.equal(lock.packages[''].devDependencies['eslint-config-next'], version);
  assert.equal(lock.packages['node_modules/eslint-config-next'].version, version);
  assert.equal(lock.packages['node_modules/@next/eslint-plugin-next'].version, version);
});

test('runtime dependency copies cannot silently revert to known vulnerable versions', () => {
  // Floors reviewed on 2026-10-03. These checks supplement, not replace, npm audit.
  for (const [name, floor] of [
    ['postcss', '8.5.23'], ['sharp', '0.35.4'],
    ['nanoid', '3.3.18'], ['baseline-browser-mapping', '2.11.0'],
  ]) {
    const installed = copies(name);
    assert.ok(installed.length, `${name} is present in the reviewed dependency graph`);
    for (const [path, entry] of installed) {
      assert.ok(atLeast(entry.version ?? '', floor), `${path} must be at least ${floor}`);
    }
  }
});

test('the unpatched braces advisory remains confined to development tooling', () => {
  const installed = copies('braces');
  for (const [path, entry] of installed) assert.equal(entry.dev, true, `${path} must not become a runtime dependency`);
  assert.equal(manifest.dependencies['eslint-config-next'], undefined);
  for (const name of ['braces', 'micromatch', 'fast-glob']) {
    assert.equal(manifest.dependencies[name], undefined);
  }
});

test('production type checking remains strict while test harnesses run separately', () => {
  const buildConfig = JSON.parse(readFileSync(new URL('../../tsconfig.build.json', import.meta.url), 'utf8'));
  const baseConfig = JSON.parse(readFileSync(new URL('../../tsconfig.json', import.meta.url), 'utf8'));
  const nextConfig = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');
  assert.equal(buildConfig.extends, './tsconfig.json');
  assert.equal(baseConfig.compilerOptions.strict, true);
  assert.deepEqual(buildConfig.exclude, ['node_modules', 'tests', 'outputs']);
  assert.equal(buildConfig.compilerOptions, undefined);
  assert.match(nextConfig, /tsconfigPath: 'tsconfig.build.json'/);
  assert.doesNotMatch(nextConfig, /ignoreBuildErrors/);
});
