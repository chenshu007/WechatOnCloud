import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRequestHostAllowed, parseAllowedHosts } from '../src/host-guard.js';

const allow = parseAllowedHosts('*.example.com');

test('deployment paths stay allowed', () => {
  assert.ok(isRequestHostAllowed('woc.example.com', undefined, allow)); // tunnel keeps public Host
  assert.ok(isRequestHostAllowed('192.168.1.10:36080', undefined, allow)); // LAN IP
  assert.ok(isRequestHostAllowed('localhost:8080', 'woc.example.com', allow)); // proxy rewrites Host
  assert.ok(isRequestHostAllowed('woc-panel:8080', 'woc.example.com', allow)); // proxy uses container name
});

test('X-Forwarded-Host cannot rescue an external Host (DNS rebinding)', () => {
  assert.ok(!isRequestHostAllowed('evil.attacker.test', '192.168.1.10', allow));
  assert.ok(!isRequestHostAllowed('evil.attacker.test', 'woc.example.com', allow));
  assert.ok(!isRequestHostAllowed('evil.attacker.test', undefined, allow));
});

test('internal Host with a foreign X-Forwarded-Host is still rejected', () => {
  assert.ok(!isRequestHostAllowed('woc-panel:8080', 'evil.attacker.test', allow));
});
