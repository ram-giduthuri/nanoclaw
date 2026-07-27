// Start-of-day / end-of-day digest of what needs your attention: GitHub review
// requests + blocked PRs (GraphQL) and today's meetings (calendarView), with EOD
// deltas via a SQLite SOD snapshot. Channel-agnostic — calls an injected
// deliver(text) that resolves the target jid (Slack today, Teams later).
import { CronExpressionParser } from 'cron-parser';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { getGraphClient } from './m365-auth.js';
import { getRouterState, setRouterState } from './db.js';
import { TIMEZONE } from './config.js';

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

export type DigestKind = 'sod' | 'eod';

export interface ReviewPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
}
export interface BlockedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  reasons: string[];
}
export interface Meeting {
  subject: string;
  start: string; // local (tz) ISO from the Prefer header
  isAllDay: boolean;
}

export interface DigestConfig {
  githubToken?: string;
  timezone: string;
  targetJid?: string;
  sodCron: string;
  eodCron: string;
}

export function getDigestConfig(): DigestConfig {
  const env = readEnvFile([
    'GITHUB_TOKEN',
    'NANOCLAW_DIGEST_TARGET',
    'NANOCLAW_DIGEST_SOD_CRON',
    'NANOCLAW_DIGEST_EOD_CRON',
  ]);
  return {
    githubToken: env.GITHUB_TOKEN,
    timezone: TIMEZONE,
    targetJid: env.NANOCLAW_DIGEST_TARGET,
    sodCron: env.NANOCLAW_DIGEST_SOD_CRON || '0 9 * * 1-5',
    eodCron: env.NANOCLAW_DIGEST_EOD_CRON || '0 18 * * 1-5',
  };
}

// --- GitHub ---

async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

export interface GithubDigest {
  reviewRequested: ReviewPr[];
  blocked: BlockedPr[];
}

interface GithubSearchData {
  reviewRequested: { nodes: Array<Record<string, any>> };
  mine: { nodes: Array<Record<string, any>> };
}

// Pure: map a GitHub GraphQL search response to the digest shape. A PR is
// "blocked" if changes were requested or its latest commit's checks failed.
export function parseGithubData(data: GithubSearchData): GithubDigest {
  const reviewRequested: ReviewPr[] = (data.reviewRequested?.nodes || [])
    .filter((n) => n?.number)
    .map((n) => ({
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: n.title,
      url: n.url,
      author: n.author?.login || '?',
      createdAt: n.createdAt,
    }));

  const blocked: BlockedPr[] = [];
  for (const n of data.mine?.nodes || []) {
    if (!n?.number) continue;
    const reasons: string[] = [];
    if (n.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes requested');
    const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
    if (rollup === 'FAILURE' || rollup === 'ERROR') reasons.push('CI failing');
    if (reasons.length) {
      blocked.push({
        repo: n.repository.nameWithOwner,
        number: n.number,
        title: n.title,
        url: n.url,
        reasons,
      });
    }
  }
  return { reviewRequested, blocked };
}

async function fetchGithub(token: string): Promise<GithubDigest> {
  // Resolve the viewer's login rather than relying on `@me` in search.
  const viewer = await githubGraphql<{ viewer: { login: string } }>(
    token,
    'query { viewer { login } }',
  );
  const me = viewer.viewer.login;

  // Cap at 50 (well above a realistic per-person count); log if a page fills
  // rather than silently dropping overflow.
  const PAGE = 50;
  const q = `
    query($rr: String!, $mine: String!, $n: Int!) {
      reviewRequested: search(query: $rr, type: ISSUE, first: $n) {
        nodes { ... on PullRequest {
          number title url createdAt
          repository { nameWithOwner }
          author { login }
        } }
      }
      mine: search(query: $mine, type: ISSUE, first: $n) {
        nodes { ... on PullRequest {
          number title url reviewDecision
          repository { nameWithOwner }
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        } }
      }
    }`;
  const data = await githubGraphql<GithubSearchData>(token, q, {
    rr: `is:open is:pr review-requested:${me} archived:false`,
    mine: `is:open is:pr author:${me} archived:false draft:false`,
    n: PAGE,
  });
  if (data.reviewRequested.nodes?.length === PAGE || data.mine.nodes?.length === PAGE) {
    logger.warn(
      { page: PAGE },
      'Digest: GitHub result page is full — some PRs may be truncated',
    );
  }
  return parseGithubData(data);
}

// --- Meetings (Graph calendarView) ---

export function localDateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d); // YYYY-MM-DD
}

async function fetchMeetings(tz: string): Promise<Meeting[]> {
  const client = getGraphClient();
  if (!client) return [];
  const now = new Date();
  // Over-fetch in UTC, filter to today's LOCAL date — avoids tz-boundary math
  // (the Prefer header returns instance times already in `tz`).
  const start = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const end = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
  const today = localDateInTz(now, tz);

  const res: { value: Array<Record<string, any>> } = await client
    .api('/me/calendarView')
    .header('Prefer', `outlook.timezone="${tz}"`)
    .query({ startDateTime: start, endDateTime: end })
    .select('subject,start,end,isAllDay,isCancelled,responseStatus')
    .orderby('start/dateTime')
    .top(50)
    .get();

  return filterMeetings(res.value || [], today);
}

// Pure: keep today's non-cancelled, non-declined events (times are already
// wall-clock in `tz` from the Prefer header, so compare the local date string).
export function filterMeetings(
  events: Array<Record<string, any>>,
  today: string,
): Meeting[] {
  return (events || [])
    .filter((e) => !e.isCancelled)
    .filter((e) => e.responseStatus?.response !== 'declined')
    .filter((e) => (e.start?.dateTime || '').slice(0, 10) === today)
    .map((e) => ({
      subject: e.subject || '(no subject)',
      start: e.start?.dateTime || '',
      isAllDay: !!e.isAllDay,
    }));
}

// --- Formatting ---

export function ageString(fromIso: string, now: Date): string {
  const ms = now.getTime() - new Date(fromIso).getTime();
  const h = Math.floor(ms / 3600000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rem = h % 24;
  return rem ? `${d}d ${rem}h` : `${d}d`;
}

export function meetingTime(m: Meeting): string {
  if (m.isAllDay) return 'all day';
  // m.start is already wall-clock in the user's tz (Prefer header) — slice HH:MM
  // directly; new Date() would reinterpret it in the host tz and double-convert.
  return m.start.length >= 16 ? m.start.slice(11, 16) : m.start;
}

const snapKey = (dateStr: string) => `digest_sod_snapshot_${dateStr}`;
export const reviewId = (p: ReviewPr) => `${p.repo}#${p.number}`;

export interface GithubLoad {
  gh: GithubDigest;
  known: boolean;
  warning?: string;
}

// Distinguish "nothing needs you" from "couldn't ask" — never claim all-clear
// on a failed fetch (that's how a dead token hides real review requests).
export async function loadGithub(cfg: DigestConfig): Promise<GithubLoad> {
  const empty: GithubDigest = { reviewRequested: [], blocked: [] };
  if (!cfg.githubToken) {
    return { gh: empty, known: false, warning: '⚠️ GitHub token not configured — review/PR status unknown.' };
  }
  try {
    return { gh: await fetchGithub(cfg.githubToken), known: true };
  } catch (err) {
    logger.warn({ err }, 'Digest: GitHub fetch failed');
    return { gh: empty, known: false, warning: '⚠️ Could not reach GitHub — review/PR status unknown.' };
  }
}

export function reviewLines(prs: ReviewPr[], now: Date): string[] {
  return prs.map(
    (p) => `   • [${reviewId(p)}](${p.url}) — ${p.author} · ${ageString(p.createdAt, now)}`,
  );
}

export function blockedLines(prs: BlockedPr[]): string[] {
  return prs.map((p) => `   • [#${p.number}](${p.url}) ${p.reasons.join(' + ')}`);
}

// Pure: build the SOD lines from resolved inputs (no I/O).
export function renderSod(load: GithubLoad, meetings: Meeting[], now: Date): string[] {
  const { gh, known, warning } = load;
  const lines = ['☀️ **Good morning.**'];
  if (warning) lines.push(warning);
  if (meetings.length) {
    const plural = meetings.length > 1 ? 's' : '';
    lines.push(
      `📅 **Today: ${meetings.length} meeting${plural}**`,
      ...meetings.map((m) => `   ${meetingTime(m)} · ${m.subject}`),
    );
  }
  if (gh.reviewRequested.length) {
    lines.push(`🔴 **Review requested (${gh.reviewRequested.length})**`, ...reviewLines(gh.reviewRequested, now));
  }
  if (gh.blocked.length) {
    lines.push(`🟠 **Your PRs blocked (${gh.blocked.length})**`, ...blockedLines(gh.blocked));
  }
  if (known && !gh.reviewRequested.length && !gh.blocked.length) {
    lines.push('✅ No PRs need you right now.');
  }
  return lines;
}

async function buildSod(
  load: GithubLoad,
  cfg: DigestConfig,
  now: Date,
  today: string,
): Promise<string[]> {
  let meetings: Meeting[] = [];
  try {
    meetings = await fetchMeetings(cfg.timezone);
  } catch (err) {
    logger.warn({ err }, 'Digest: meetings fetch failed');
  }
  const lines = renderSod(load, meetings, now);
  // Snapshot awaiting-review for the EOD diff — only when GitHub answered.
  if (load.known) {
    setRouterState(snapKey(today), JSON.stringify({ reviewIds: load.gh.reviewRequested.map(reviewId) }));
  }
  return lines;
}

export function parseSnapshotIds(raw: string | undefined): Set<string> {
  try {
    return new Set<string>(raw ? JSON.parse(raw).reviewIds || [] : []);
  } catch {
    return new Set<string>(); // corrupt snapshot — treat as no morning baseline
  }
}

// Pure: build the EOD lines from resolved inputs (no I/O). `morningIds` is the
// SOD snapshot; it annotates but must NEVER gate what we show.
export function renderEod(load: GithubLoad, morningIds: Set<string>, now: Date): string[] {
  const { gh, known, warning } = load;
  const lines = ['🌙 **End of day.**'];
  if (warning) lines.push(warning);
  if (!known) return lines;

  const nowIds = new Set(gh.reviewRequested.map(reviewId));
  const cleared = [...morningIds].filter((id) => !nowIds.has(id));

  if (gh.reviewRequested.length) {
    lines.push(`🔴 **Awaiting your review (${gh.reviewRequested.length})**`);
    for (const p of gh.reviewRequested) {
      const since = morningIds.has(reviewId(p)) ? 'since this morning' : 'new today';
      lines.push(`   • [${reviewId(p)}](${p.url}) — ${p.author} · ${ageString(p.createdAt, now)} · ${since}`);
    }
  }
  if (gh.blocked.length) {
    lines.push(`🟠 **Your PRs still blocked (${gh.blocked.length})**`, ...blockedLines(gh.blocked));
  }
  if (cleared.length) lines.push(`✅ Cleared today: ${cleared.length}`);
  // Only ever claim clear when nothing actually awaits you right now.
  if (!gh.reviewRequested.length && !gh.blocked.length) {
    lines.push(cleared.length ? '✅ All caught up.' : '✅ All clear.');
  }
  return lines;
}

function buildEod(load: GithubLoad, now: Date, today: string): string[] {
  const morningIds = parseSnapshotIds(getRouterState(snapKey(today)));
  return renderEod(load, morningIds, now);
}

export async function buildDigest(
  kind: DigestKind,
  cfg: DigestConfig,
  now: Date = new Date(),
): Promise<string> {
  const load = await loadGithub(cfg);
  const today = localDateInTz(now, cfg.timezone);
  const lines = kind === 'sod' ? await buildSod(load, cfg, now, today) : buildEod(load, now, today);
  return lines.join('\n');
}

// --- Scheduling ---

export interface DigestSchedulerDeps {
  deliver: (text: string) => Promise<void>;
}

function scheduleNext(
  kind: DigestKind,
  cronExpr: string,
  cfg: DigestConfig,
  deps: DigestSchedulerDeps,
): void {
  let next: Date;
  try {
    next = CronExpressionParser.parse(cronExpr, { tz: cfg.timezone }).next().toDate();
  } catch (err) {
    logger.error({ kind, cronExpr, err }, 'Digest: invalid cron, not scheduling');
    return;
  }
  const delay = Math.max(1000, next.getTime() - Date.now());
  logger.info({ kind, next: next.toISOString() }, 'Digest scheduled');
  setTimeout(async () => {
    try {
      const text = await buildDigest(kind, cfg);
      await deps.deliver(text);
      logger.info({ kind }, 'Digest delivered');
    } catch (err) {
      logger.error({ kind, err }, 'Digest run failed');
    } finally {
      scheduleNext(kind, cronExpr, cfg, deps); // reschedule for the next occurrence
    }
  }, delay);
}

export function startDigestScheduler(deps: DigestSchedulerDeps): void {
  const cfg = getDigestConfig();
  if (!cfg.githubToken) {
    logger.info('Digest: GITHUB_TOKEN not set — digest disabled');
    return;
  }
  if (!cfg.targetJid) {
    logger.warn('Digest: NANOCLAW_DIGEST_TARGET not set — digest disabled');
    return;
  }
  scheduleNext('sod', cfg.sodCron, cfg, deps);
  scheduleNext('eod', cfg.eodCron, cfg, deps);
}
