import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory router_state so we can assert the real SOD→EOD snapshot roundtrip.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('./db.js', () => ({
  getRouterState: (k: string) => store.get(k),
  setRouterState: (k: string, v: string) => {
    store.set(k, v);
  },
}));
// No Graph client → fetchMeetings returns [] (keeps the test to GitHub + snapshot).
vi.mock('./m365-auth.js', () => ({ getGraphClient: () => null }));

import { buildDigest } from './email-digest.js';

const cfg = {
  githubToken: 't',
  timezone: 'UTC',
  targetJid: 'x',
  sodCron: '',
  eodCron: '',
};
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
const node = (n: number) => ({
  number: n,
  repository: { nameWithOwner: 'o/r' },
  author: { login: 'a' },
  url: 'u',
  createdAt: '2026-07-27T14:00:00Z',
});
function mockGithub(reviewNodes: unknown[], mineNodes: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(ok({ viewer: { login: 'me' } }))
      .mockResolvedValueOnce(
        ok({
          reviewRequested: { nodes: reviewNodes },
          mine: { nodes: mineNodes },
        }),
      ),
  );
}

describe('buildDigest SOD→EOD snapshot roundtrip', () => {
  const now = new Date('2026-07-27T16:00:00Z');
  beforeEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('SOD persists the awaiting-review snapshot; EOD reads it to annotate new vs since-morning', async () => {
    mockGithub([node(1)]); // morning: #1 awaiting
    const sod = await buildDigest('sod', cfg, now);
    expect(sod).toContain('☀️ **Good morning.**');
    expect(sod).toContain('Review requested (1)');
    expect(store.size).toBe(1); // snapshot written

    vi.unstubAllGlobals();
    mockGithub([node(1), node(2)]); // evening: #1 still open, #2 arrived after SOD
    const eod = await buildDigest('eod', cfg, now);
    expect(eod).toContain('Awaiting your review (2)');
    expect(eod).toContain('o/r#1](u) — a · 2h · since this morning');
    expect(eod).toContain('o/r#2](u) — a · 2h · new today');
    expect(eod).not.toContain('All clear');
  });

  it('a failed GitHub fetch on SOD writes no snapshot and never claims all-clear', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    const sod = await buildDigest('sod', cfg, now);
    expect(sod).toContain('Could not reach GitHub');
    expect(sod).not.toContain('No PRs need you');
    expect(store.size).toBe(0);
  });
});
