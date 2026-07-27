// Deterministic classifier: maps a message to one `source` (strict precedence)
// and decides keep-in-inbox vs file. Conservative — only high-confidence dev
// noise files; everything else keeps, so we never re-bury a person or a noreply@
// alert. Pure function, no network.

export type EmailSource =
  | 'github'
  | 'jira'
  | 'confluence'
  | 'ci'
  | 'calendar'
  | 'human'
  | 'automated'
  | 'unknown';

export interface ClassifierInput {
  fromAddress: string;
  fromName?: string;
  subject?: string;
  bodyPreview?: string;
  headers?: Array<{ name: string; value: string }>;
  /** The user's own GitHub login, to detect a direct @mention of them. */
  githubHandle?: string;
}

export interface EmailClassification {
  source: EmailSource;
  /** X-GitHub-Reason value when source === 'github' (e.g. 'review_requested'). */
  githubReason?: string;
  /** True → keep in inbox, unread (the inbox itself is the notification). */
  actionNeeded: boolean;
  /** 'file' → move to the NanoClaw folder + tag + mark read. 'keep' → leave untouched. */
  disposition: 'keep' | 'file';
  /** Outlook category to assign when filing. Undefined for 'keep'. */
  category?: string;
  /** Kept mail with no precise rule (automated/unknown) — gets the review tag. */
  uncertainKeep?: boolean;
}

// GitHub stamps review_requested/mention on a whole thread, so keep only the
// email that IS the ask (review-request body / fresh @mention); file the rest.
// (No `changes_requested` reason exists — that's digest-only.)
function isGithubActionable(reason: string, input: ClassifierInput): boolean {
  if (reason === 'assign') return true;
  const isAskReason =
    reason === 'review_requested' || reason === 'mention' || reason === 'team_mention';
  const body = (input.bodyPreview || '').toLowerCase();
  // No body to inspect (empty/HTML-only preview) → don't risk filing a real ask; keep it.
  if (!body) return isAskReason;
  if (reason === 'review_requested') return body.includes('requested your review');
  if (reason === 'mention' || reason === 'team_mention') {
    const handle = input.githubHandle?.toLowerCase();
    return !!handle && body.includes(`@${handle}`);
  }
  return false;
}

// Marketing/automation senders — kept (never moved; a noreply@ can be a real
// alert). Checked after human so a person is never mislabeled.
const AUTOMATED_SENDER_PATTERNS = [
  /^no-?reply@/i,
  /^noreply@/i,
  /^do-?not-?reply@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^notifications?@/i,
  /^alerts?@/i,
  /^newsletter@/i,
  /^marketing@/i,
  /^info@/i,
  /^team@/i,
  /^updates?@/i,
  /^digest@/i,
  /^bounces?@/i,
  /^feedback@/i,
  /^automated@/i,
];

// Non-GitHub CI bots, anchored to the vendor DOMAIN or a CI-shaped local-part —
// never a bare substring, so a person like sarah.jenkins@ isn't filed.
const CI_SENDER_PATTERNS = [
  /@[^@]*(sonarqube|sonarcloud|sonarsource|circleci|jenkins|buildkite)/i, // vendor in domain
  /^(ci|builds?|jenkins|sonarqube|sonarcloud|github-actions)@/i, // CI-shaped local-part
];

export function isLikelyAutomated(senderAddress: string): boolean {
  return AUTOMATED_SENDER_PATTERNS.some((p) => p.test(senderAddress));
}

function header(
  headers: ClassifierInput['headers'],
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  const h = headers.find((x) => x.name.toLowerCase() === lower);
  return h?.value;
}

function isCalendar(input: ClassifierInput): boolean {
  const cc = header(input.headers, 'Content-Class')?.toLowerCase() || '';
  if (cc.includes('calendar')) return true; // urn:content-classes:calendarmessage
  const s = (input.subject || '').trim();
  return /^(invitation:|cancell?ed:|accepted:|declined:|tentative:|updated:)/i.test(
    s,
  );
}

// A Jira/Confluence "mentioned you" is an ask (keep); routine activity files.
function isAtlassianMention(input: ClassifierInput): boolean {
  const text = `${input.subject || ''} ${input.bodyPreview || ''}`.toLowerCase();
  return text.includes('mentioned you');
}

/** Whether a sender looks like a real person rather than a role/bot address. */
function isHuman(input: ClassifierInput): boolean {
  const addr = input.fromAddress.toLowerCase();
  const name = (input.fromName || '').trim();
  if (!name) return false;
  // A display name equal to the address is a bot tell; a real name differs.
  if (name.toLowerCase() === addr) return false;
  if (isLikelyAutomated(addr)) return false;
  // Obvious no-reply / notification local-parts even without the patterns above.
  if (/(^|[._-])(no-?reply|donotreply|notifications?|mailer|bounce)([._-]|@)/i.test(addr))
    return false;
  return true;
}

export function classifyEmail(input: ClassifierInput): EmailClassification {
  const addr = input.fromAddress.toLowerCase();

  // First match wins — order is the source precedence. Only real notifications
  // count as github (reason header, or notifications@); noreply@ security mail
  // (2FA/token, no reason) falls through to keep.
  const ghReason = header(input.headers, 'X-GitHub-Reason')?.toLowerCase();
  if (ghReason || addr === 'notifications@github.com') {
    const reason = ghReason || 'subscribed';
    const actionNeeded = isGithubActionable(reason, input);
    return actionNeeded
      ? { source: 'github', githubReason: reason, actionNeeded: true, disposition: 'keep' }
      : {
          source: 'github',
          githubReason: reason,
          actionNeeded: false,
          disposition: 'file',
          category: 'GitHub',
        };
  }

  if (/^jira@/i.test(addr)) {
    return isAtlassianMention(input)
      ? { source: 'jira', actionNeeded: true, disposition: 'keep' }
      : { source: 'jira', actionNeeded: false, disposition: 'file', category: 'Jira' };
  }

  if (/^confluence@/i.test(addr)) {
    return isAtlassianMention(input)
      ? { source: 'confluence', actionNeeded: true, disposition: 'keep' }
      : { source: 'confluence', actionNeeded: false, disposition: 'file', category: 'Confluence' };
  }

  if (CI_SENDER_PATTERNS.some((p) => p.test(addr))) {
    return { source: 'ci', actionNeeded: false, disposition: 'file', category: 'CI' };
  }

  if (isCalendar(input)) {
    return { source: 'calendar', actionNeeded: false, disposition: 'keep' };
  }

  if (isHuman(input)) {
    return { source: 'human', actionNeeded: false, disposition: 'keep' };
  }

  if (isLikelyAutomated(addr)) {
    return { source: 'automated', actionNeeded: false, disposition: 'keep', uncertainKeep: true };
  }

  return { source: 'unknown', actionNeeded: false, disposition: 'keep', uncertainKeep: true };
}

export interface ActionContext {
  dryRun: boolean;
  fileSources: string[];
}

export interface EmailAction {
  /** Actually move the email to the folder (mark read + move). */
  file: boolean;
  /** Apply the review tag in-place (no move). */
  tag: boolean;
}

// Decide what to actually do, given the classification + runtime config. Filing
// needs live mode AND the source enabled; the review tag needs live mode.
export function decideAction(c: EmailClassification, ctx: ActionContext): EmailAction {
  if (c.disposition === 'file') {
    return { file: !ctx.dryRun && ctx.fileSources.includes(c.source), tag: false };
  }
  return { file: false, tag: !!c.uncertainKeep && !ctx.dryRun };
}
