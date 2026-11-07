import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression: billing form must not access variables belonging to the generic user editor.
test('billing form submission does not reference undefined action', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function showBillingRule(cid)');
  const end = source.indexOf('async function showPropertyBilling(', start);
  assert.ok(start >= 0 && end > start);
  const billing = source.slice(start, end);
  assert.doesNotMatch(billing, /action\s*===\s*['"]edit-user['"]/);
  assert.ok(billing.includes("api('/contracts/'+cid+'/billing-rule','PUT',data)"));
});
