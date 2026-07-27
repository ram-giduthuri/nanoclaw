import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ageString,
  meetingTime,
  localDateInTz,
  parseSnapshotIds,
  parseGithubData,
  filterMeetings,
  reviewId,
  reviewLines,
  blockedLines,
  renderSod,
  renderEod,
  loadGithub,
  type ReviewPr,
  type BlockedPr,
  type GithubLoad,
} from './email-digest.js';

// A fixed clock — never use real Date in assertions.
const NOW = new Date('2026-07-27T18:00:00.000Z');
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3600_000).toISOString();

const pr = (over: Partial<ReviewPr> = {}): ReviewPr => ({
  repo: 'Tereina/pes',
  number: 1,
  title: 't',
  url: 'https://gh/1',
  author: 'alice',
  createdAt: hoursAgo(2),
  ...over,
});
const blocked = (over: Partial<BlockedPr> = {}): BlockedPr => ({
  repo: 'Tereina/pes',
  number: 9,
  title: 't',
  url: 'https://gh/9',
  reasons: ['CI failing'],
  ...over,
});
const load = (over: Partial<GithubLoad> = {}): GithubLoad => ({
  gh: { reviewRequested: [], blocked: [] },
  known: true,
  ...over,
});

describe('ageString', () => {
  it.each([
    [0.5, '<1h'],
    [1, '1h'],
    [23, '23h'],
    [24, '1d'],
    [25, '1d 1h'],
    [48, '2d'],
    [49, '2d 1h'],
  ])('%ih ago → %s', (h, expected) => {
    expect(ageString(hoursAgo(h), NOW)).toBe(expected);
  });
});

describe('meetingTime', () => {
  it('renders all-day', () => {
    expect(
      meetingTime({ subject: 'x', start: '2026-07-27', isAllDay: true }),
    ).toBe('all day');
  });
  it('slices HH:MM from the wall-clock string (no tz re-parse)', () => {
    expect(
      meetingTime({
        subject: 'x',
        start: '2026-07-27T09:30:00.0000000',
        isAllDay: false,
      }),
    ).toBe('09:30');
  });
  it('returns a too-short string as-is', () => {
    expect(meetingTime({ subject: 'x', start: 'TBD', isAllDay: false })).toBe(
      'TBD',
    );
  });
  it('boundary: exactly 16 chars slices; 15 returns as-is', () => {
    expect(
      meetingTime({ subject: 'x', start: '2026-07-27T09:30', isAllDay: false }),
    ).toBe('09:30'); // 16
    expect(
      meetingTime({ subject: 'x', start: '2026-07-27T09:3', isAllDay: false }),
    ).toBe('2026-07-27T09:3'); // 15
  });
});

describe('localDateInTz', () => {
  it('maps a UTC instant to the correct local date across tz boundaries', () => {
    const instant = new Date('2026-07-25T02:00:00Z'); // 7pm PT on the 24th
    expect(localDateInTz(instant, 'America/Los_Angeles')).toBe('2026-07-24');
    expect(localDateInTz(instant, 'UTC')).toBe('2026-07-25');
  });
});

describe('parseSnapshotIds', () => {
  it.each([
    ['undefined', undefined, 0],
    ['empty ids', JSON.stringify({ reviewIds: [] }), 0],
    ['two ids', JSON.stringify({ reviewIds: ['a', 'b'] }), 2],
    ['missing reviewIds key', JSON.stringify({ other: 1 }), 0],
    ['corrupt json', '{not json', 0],
  ])('%s → set size %i', (_label, raw, size) => {
    expect(parseSnapshotIds(raw as string | undefined).size).toBe(size);
  });
});

describe('reviewId / line formatters', () => {
  it('reviewId is repo#number', () => {
    expect(reviewId(pr({ repo: 'o/r', number: 42 }))).toBe('o/r#42');
  });
  it('reviewLines includes repo#num, author, age', () => {
    const [line] = reviewLines(
      [pr({ repo: 'o/r', number: 5, author: 'bob', createdAt: hoursAgo(3) })],
      NOW,
    );
    expect(line).toContain('[o/r#5](https://gh/1)');
    expect(line).toContain('bob');
    expect(line).toContain('3h');
  });
  it('blockedLines joins reasons with +', () => {
    const [line] = blockedLines([
      blocked({
        number: 7,
        url: 'https://gh/7',
        reasons: ['changes requested', 'CI failing'],
      }),
    ]);
    expect(line).toBe('   • [#7](https://gh/7) changes requested + CI failing');
  });
});

describe('parseGithubData', () => {
  it('maps review requests and defaults a missing author to "?"', () => {
    const data = {
      reviewRequested: {
        nodes: [
          {
            number: 1,
            title: 'a',
            url: 'u1',
            createdAt: 'c1',
            repository: { nameWithOwner: 'o/r' },
            author: { login: 'x' },
          },
          {
            number: 2,
            title: 'b',
            url: 'u2',
            createdAt: 'c2',
            repository: { nameWithOwner: 'o/r' },
            author: null,
          },
        ],
      },
      mine: { nodes: [] },
    };
    const out = parseGithubData(data);
    expect(out.reviewRequested).toHaveLength(2);
    expect(out.reviewRequested[1].author).toBe('?');
  });

  it('filters out nodes without a number (non-PR search hits)', () => {
    const data = {
      reviewRequested: {
        nodes: [
          { foo: 1 },
          null,
          { number: 3, repository: { nameWithOwner: 'o/r' } },
        ],
      },
      mine: { nodes: [] },
    };
    expect(parseGithubData(data as any).reviewRequested).toHaveLength(1);
  });

  it.each([
    [
      'CHANGES_REQUESTED only',
      'CHANGES_REQUESTED',
      'SUCCESS',
      ['changes requested'],
    ],
    ['CI FAILURE only', 'APPROVED', 'FAILURE', ['CI failing']],
    ['CI ERROR only', 'APPROVED', 'ERROR', ['CI failing']],
    [
      'both',
      'CHANGES_REQUESTED',
      'FAILURE',
      ['changes requested', 'CI failing'],
    ],
  ])('blocked: %s', (_l, decision, rollup, reasons) => {
    const data = {
      reviewRequested: { nodes: [] },
      mine: {
        nodes: [
          {
            number: 9,
            title: 't',
            url: 'u',
            reviewDecision: decision,
            repository: { nameWithOwner: 'o/r' },
            commits: {
              nodes: [{ commit: { statusCheckRollup: { state: rollup } } }],
            },
          },
        ],
      },
    };
    const out = parseGithubData(data);
    expect(out.blocked).toHaveLength(1);
    expect(out.blocked[0].reasons).toEqual(reasons);
  });

  it('does NOT mark a healthy PR (approved + passing) as blocked', () => {
    const data = {
      reviewRequested: { nodes: [] },
      mine: {
        nodes: [
          {
            number: 9,
            repository: { nameWithOwner: 'o/r' },
            reviewDecision: 'APPROVED',
            commits: {
              nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }],
            },
          },
        ],
      },
    };
    expect(parseGithubData(data).blocked).toHaveLength(0);
  });

  it('tolerates missing rollup / missing commits (null-safe)', () => {
    const data = {
      reviewRequested: { nodes: [] },
      mine: {
        nodes: [
          {
            number: 9,
            repository: { nameWithOwner: 'o/r' },
            reviewDecision: 'REVIEW_REQUIRED',
          },
        ],
      },
    };
    expect(parseGithubData(data).blocked).toHaveLength(0);
  });

  it('handles empty/missing node arrays', () => {
    expect(parseGithubData({ reviewRequested: {}, mine: {} } as any)).toEqual({
      reviewRequested: [],
      blocked: [],
    });
  });
});

describe('filterMeetings', () => {
  const ev = (over: Record<string, any> = {}) => ({
    subject: 'Standup',
    start: { dateTime: '2026-07-27T09:00:00.0000000' },
    isCancelled: false,
    responseStatus: { response: 'accepted' },
    isAllDay: false,
    ...over,
  });
  const TODAY = '2026-07-27';

  it('keeps an accepted meeting today', () => {
    expect(filterMeetings([ev()], TODAY)).toHaveLength(1);
  });
  it('drops cancelled, declined, and other-day events', () => {
    const events = [
      ev({ isCancelled: true }),
      ev({ responseStatus: { response: 'declined' } }),
      ev({ start: { dateTime: '2026-07-28T09:00:00' } }),
    ];
    expect(filterMeetings(events, TODAY)).toHaveLength(0);
  });
  it('keeps tentative/not-responded, defaults missing subject', () => {
    const out = filterMeetings(
      [
        ev({
          responseStatus: { response: 'tentativelyAccepted' },
          subject: '',
        }),
      ],
      TODAY,
    );
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('(no subject)');
  });
});

describe('renderSod', () => {
  it('leads with the header and shows the warning when GitHub is unknown', () => {
    const lines = renderSod(
      load({ known: false, warning: '⚠️ unknown' }),
      [],
      NOW,
    );
    expect(lines[0]).toBe('☀️ **Good morning.**');
    expect(lines).toContain('⚠️ unknown');
    // never claims "no PRs need you" when we couldn't ask
    expect(lines.join('\n')).not.toContain('No PRs need you');
  });

  it('pluralizes meetings and lists review + blocked', () => {
    const lines = renderSod(
      load({ gh: { reviewRequested: [pr()], blocked: [blocked()] } }),
      [
        { subject: 'A', start: '2026-07-27T09:00:00.0000000', isAllDay: false },
        { subject: 'B', start: '2026-07-27T10:00:00.0000000', isAllDay: false },
      ],
      NOW,
    );
    const text = lines.join('\n');
    expect(text).toContain('Today: 2 meetings');
    expect(text).toContain('Review requested (1)');
    expect(text).toContain('Your PRs blocked (1)');
  });

  it('singular "meeting" for one', () => {
    const lines = renderSod(
      load(),
      [{ subject: 'A', start: '2026-07-27T09:00:00', isAllDay: false }],
      NOW,
    );
    expect(lines.join('\n')).toContain('Today: 1 meeting**');
  });

  it('says "No PRs need you" only when known and empty', () => {
    expect(renderSod(load({ known: true }), [], NOW).join('\n')).toContain(
      'No PRs need you',
    );
  });
});

describe('renderEod', () => {
  it('when GitHub is unknown, shows only header + warning (no all-clear)', () => {
    const lines = renderEod(
      load({ known: false, warning: '⚠️ down' }),
      new Set(),
      NOW,
    );
    expect(lines).toEqual(['🌙 **End of day.**', '⚠️ down']);
  });

  it('lists a review request that arrived AFTER the morning snapshot (regression: no false all-clear)', () => {
    const lines = renderEod(
      load({ gh: { reviewRequested: [pr({ number: 2 })], blocked: [] } }),
      new Set(['Tereina/pes#1']), // morning had #1, now it's #2
      NOW,
    );
    const text = lines.join('\n');
    expect(text).toContain('Awaiting your review (1)');
    expect(text).toContain('Tereina/pes#2');
    expect(text).toContain('new today');
    expect(text).not.toContain('All clear');
  });

  it('surfaces current requests even when the snapshot is missing', () => {
    const lines = renderEod(
      load({ gh: { reviewRequested: [pr()], blocked: [] } }),
      new Set(),
      NOW,
    );
    expect(lines.join('\n')).toContain('Awaiting your review (1)');
    expect(lines.join('\n')).not.toContain('All clear');
  });

  it('annotates since-morning vs new-today and counts cleared', () => {
    const lines = renderEod(
      load({
        gh: {
          reviewRequested: [pr({ number: 1 }), pr({ number: 3 })],
          blocked: [],
        },
      }),
      new Set(['Tereina/pes#1', 'Tereina/pes#2']), // #2 got cleared, #3 is new
      NOW,
    );
    const text = lines.join('\n');
    expect(text).toContain(
      'Tereina/pes#1](https://gh/1) — alice · 2h · since this morning',
    );
    expect(text).toContain(
      'Tereina/pes#3](https://gh/1) — alice · 2h · new today',
    );
    expect(text).toContain('Cleared today: 1');
  });

  it('"All clear" only when nothing awaits and nothing cleared', () => {
    expect(renderEod(load(), new Set(), NOW).join('\n')).toContain(
      '✅ All clear.',
    );
  });

  it('"All caught up" when everything from the morning is cleared', () => {
    const lines = renderEod(load(), new Set(['Tereina/pes#1']), NOW);
    const text = lines.join('\n');
    expect(text).toContain('All caught up.');
    expect(text).not.toContain('All clear.');
  });

  it('never says clear while a PR is blocked', () => {
    const lines = renderEod(
      load({ gh: { reviewRequested: [], blocked: [blocked()] } }),
      new Set(),
      NOW,
    );
    const text = lines.join('\n');
    expect(text).toContain('still blocked');
    expect(text).not.toContain('All clear');
  });
});

describe('loadGithub (fetch mocked)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const cfg = { githubToken: 't', timezone: 'UTC', sodCron: '', eodCron: '' };
  const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });

  it('no token → known=false with a "not configured" warning', async () => {
    const out = await loadGithub({ ...cfg, githubToken: undefined });
    expect(out.known).toBe(false);
    expect(out.warning).toContain('not configured');
  });

  it('success → known=true with parsed PRs, and sends a well-formed request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ viewer: { login: 'me' } }))
      .mockResolvedValueOnce(
        ok({
          reviewRequested: {
            nodes: [
              {
                number: 1,
                repository: { nameWithOwner: 'o/r' },
                author: { login: 'a' },
              },
            ],
          },
          mine: { nodes: [] },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const out = await loadGithub(cfg);
    expect(out.known).toBe(true);
    expect(out.gh.reviewRequested).toHaveLength(1);
    // request shape
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('bearer t');
    expect(JSON.parse(init.body).query).toContain('viewer');
  });

  it('malformed JSON body → known=false (never treated as all-clear)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    );
    const out = await loadGithub(cfg);
    expect(out.known).toBe(false);
  });

  it('non-2xx response → known=false with a "Could not reach" warning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    const out = await loadGithub(cfg);
    expect(out.known).toBe(false);
    expect(out.warning).toContain('Could not reach');
  });

  it('GraphQL errors array → known=false (never masquerades as all-clear)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ errors: [{ message: 'bad' }] }),
        }),
    );
    const out = await loadGithub(cfg);
    expect(out.known).toBe(false);
  });
});
