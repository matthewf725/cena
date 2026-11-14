import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const itemId = '70000000-0000-4000-8000-000000000001';
const draftId = '70000000-0000-4000-8000-000000000002';
const updatedAt = '2026-11-13T18:19:20.123456+00:00';
const recipe = ['Warm the sauce in a skillet for 3 minutes.', 'Toss the cooked pasta in the warm sauce.'];
const originalFetch = globalThis.fetch;
let handle;

globalThis.Deno = {
  env: { get: (name) => ({ SUPABASE_URL: 'https://database.example.test', SUPABASE_ANON_KEY: 'public', OPENAI_API_KEY: 'mock-key' })[name] },
  serve: (handler) => { handle = handler; },
};
await import('../supabase/functions/generate-prep/index.ts');
after(() => {
  delete globalThis.Deno;
  globalThis.fetch = originalFetch;
});

const invoke = (authorization = 'Bearer mock-user') => handle(new Request('https://functions.example.test', {
  method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
  body: JSON.stringify({ item_id: itemId }),
}));

function mockWorkflow({ role = 'owner', stale = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push({ path, method: options.method });
    if (path === '/auth/v1/user') return Response.json({ id: 'test-merchant' });
    if (path.endsWith('/merchant_memberships')) return Response.json(role ? [{ role }] : []);
    if (path.endsWith('/catalog_items')) return Response.json([{ id: itemId }]);
    if (path.endsWith('/prep_drafts') && options.method === 'PATCH') {
      assert.equal(parsed.searchParams.get('id'), `eq.${draftId}`);
      assert.equal(parsed.searchParams.get('updated_at'), `eq.${updatedAt}`);
      const body = JSON.parse(options.body);
      assert.deepEqual(body.generated_steps, recipe);
      assert.equal(body.published_steps, undefined);
      return Response.json(stale ? [] : [{ updated_at: 'new-revision' }]);
    }
    if (path.endsWith('/prep_drafts')) {
      assert.equal(parsed.searchParams.get('catalog_item_id'), `eq.${itemId}`);
      return Response.json([{ id: draftId, restaurant_id: 'test-restaurant', updated_at: updatedAt, source_steps: recipe }]);
    }
    assert.equal(parsed.host, 'api.openai.com');
    const prompt = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(prompt.messages[1].content), { provided_steps: recipe });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ steps: recipe }) } }] });
  };
  return calls;
}

test('prep generation needs authorization and restaurant access', async () => {
  const calls = mockWorkflow({ role: null });
  assert.equal((await invoke('missing')).status, 401);
  assert.equal((await invoke()).status, 403);
  assert.ok(calls.every(({ path }) => !path.endsWith('/completions')));
});

test('prep generation rewrites only recipe steps and saves a private revision', async () => {
  mockWorkflow();
  const response = await invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { item_id: itemId, generated_steps: recipe, updated_at: 'new-revision', status: 'private_draft' });
});

test('prep generation cannot replace a concurrently edited recipe', async () => {
  mockWorkflow({ stale: true });
  assert.equal((await invoke()).status, 409);
});
