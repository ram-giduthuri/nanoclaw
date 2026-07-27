import { describe, it, expect } from 'vitest';
import { classifyEmail, decideAction } from './email-classifier.js';

const gh = (reason?: string, body = '') => ({
  fromAddress: 'notifications@github.com',
  fromName: 'GitHub',
  subject: '[Tereina/payment-request-service] PR #380',
  bodyPreview: body,
  headers: reason ? [{ name: 'X-GitHub-Reason', value: reason }] : [],
  githubHandle: 'ram-giduthuri',
});

describe('classifyEmail', () => {
  it('keeps the actual review-request email', () => {
    const c = classifyEmail(gh('review_requested', '@stefan requested your review on: repo#380 title.'));
    expect(c.source).toBe('github');
    expect(c.actionNeeded).toBe(true);
    expect(c.disposition).toBe('keep');
  });

  it('files thread noise that merely carries review_requested (merge/approve on a reviewed PR)', () => {
    // The whole thread is stamped review_requested once you are a reviewer; only
    // the ask itself should stay in the inbox.
    expect(classifyEmail(gh('review_requested', 'Merged #435 into main.')).disposition).toBe('file');
    expect(classifyEmail(gh('review_requested', '@harald approved this pull request.')).disposition).toBe('file');
    expect(classifyEmail(gh('review_requested', 'Quality Gate passed')).category).toBe('GitHub');
  });

  it('keeps a fresh direct @mention, files mention-tagged thread noise', () => {
    expect(classifyEmail(gh('mention', '@ram-giduthuri could you take a look?')).disposition).toBe('keep');
    // A sonar bot comment on a thread you were mentioned in — no fresh @mention.
    expect(classifyEmail(gh('mention', 'sonarqube-tereina[bot] Quality Gate passed')).disposition).toBe('file');
  });

  it('keeps a review_requested/mention email when bodyPreview is empty (safe fallback)', () => {
    expect(classifyEmail(gh('review_requested', '')).disposition).toBe('keep');
    expect(classifyEmail(gh('mention', '')).disposition).toBe('keep');
    // A non-ask reason with an empty body still files.
    expect(classifyEmail(gh('subscribed', '')).disposition).toBe('file');
  });

  it('files non-actionable GitHub (subscribed/author/ci/state_change/comment) with GitHub tag', () => {
    for (const r of ['subscribed', 'author', 'ci_activity', 'state_change', 'comment']) {
      const c = classifyEmail(gh(r, 'some body'));
      expect(c.disposition, r).toBe('file');
      expect(c.category, r).toBe('GitHub');
    }
  });

  it('routes github.com sender to GitHub branch before the automated pattern', () => {
    // notifications@ matches ^notifications?@ — precedence must pick github first.
    const c = classifyEmail(gh(undefined));
    expect(c.source).toBe('github');
    expect(c.disposition).toBe('file');
  });

  it('files Jira and Confluence with their own tags', () => {
    expect(classifyEmail({ fromAddress: 'jira@tereina.atlassian.net' }).category).toBe('Jira');
    expect(
      classifyEmail({ fromAddress: 'confluence@tereina.atlassian.net' }).category,
    ).toBe('Confluence');
  });

  it('keeps Jira/Confluence "mentioned you" in the inbox, files routine activity', () => {
    expect(
      classifyEmail({ fromAddress: 'jira@tereina.atlassian.net', subject: '[JIRA] Stefan Arnold mentioned you on DA-435' }).disposition,
    ).toBe('keep');
    expect(
      classifyEmail({ fromAddress: 'jira@tereina.atlassian.net', subject: '[JIRA] (PAYR-145) status changed' }).disposition,
    ).toBe('file');
    expect(
      classifyEmail({ fromAddress: 'confluence@tereina.atlassian.net', subject: 'Brady mentioned you on a page' }).disposition,
    ).toBe('keep');
  });

  it('flags automated + unknown keeps for the review tag, not confident keeps', () => {
    expect(classifyEmail({ fromAddress: 'newsletter@company.com' }).uncertainKeep).toBe(true); // automated
    expect(classifyEmail({ fromAddress: 'system@randomvendor.io' }).uncertainKeep).toBe(true); // unknown, no display name
    expect(
      classifyEmail({ fromAddress: 'rolf.haag@tereina.com', fromName: 'Rolf Haag' }).uncertainKeep,
    ).toBeFalsy(); // human
  });

  it('files non-GitHub CI bots with the CI tag', () => {
    expect(classifyEmail({ fromAddress: 'no-reply@sonarqube.example.com' }).source).toBe('ci');
    expect(classifyEmail({ fromAddress: 'ci@company.com' }).source).toBe('ci');
    expect(classifyEmail({ fromAddress: 'notifications@circleci.com' }).category).toBe('CI');
  });

  it('does NOT mistake a human with a CI-like surname for a CI bot', () => {
    // "sarah.jenkins@tereina.com" must not match the jenkins CI pattern.
    const c = classifyEmail({ fromAddress: 'sarah.jenkins@tereina.com', fromName: 'Sarah Jenkins' });
    expect(c.source).toBe('human');
    expect(c.disposition).toBe('keep');
  });

  it('keeps calendar/meeting messages untouched', () => {
    const byHeader = classifyEmail({
      fromAddress: 'someone@tereina.com',
      fromName: 'Someone',
      headers: [{ name: 'Content-Class', value: 'urn:content-classes:calendarmessage' }],
    });
    expect(byHeader.source).toBe('calendar');
    expect(byHeader.disposition).toBe('keep');
    expect(classifyEmail({ fromAddress: 'x@y.com', subject: 'Canceled: Standup' }).source).toBe(
      'calendar',
    );
  });

  it('keeps real human mail in the inbox', () => {
    const c = classifyEmail({ fromAddress: 'rolf.haag@tereina.com', fromName: 'Rolf Haag' });
    expect(c.source).toBe('human');
    expect(c.disposition).toBe('keep');
  });

  it('keeps GitHub security/auth mail (noreply@github.com) — never files a 2FA code', () => {
    const sudo = classifyEmail({
      fromAddress: 'noreply@github.com',
      fromName: 'GitHub',
      subject: '[GitHub] Sudo email verification code',
    });
    expect(sudo.source).not.toBe('github');
    expect(sudo.disposition).toBe('keep');
    const token = classifyEmail({
      fromAddress: 'noreply@github.com',
      fromName: 'GitHub',
      subject: '[GitHub] A personal access token (classic) has been regenerated',
    });
    expect(token.disposition).toBe('keep');
  });

  it('NEVER files a noreply vendor alert — the anti-re-bury guarantee', () => {
    const c = classifyEmail({
      fromAddress: 'no-reply@sardine.ai',
      fromName: 'Sardine',
      subject: 'Webhook Failure - Action Required',
    });
    expect(c.source).toBe('automated');
    expect(c.disposition).toBe('keep'); // tagged only, never moved
  });

  it('keeps unknown senders (default-safe)', () => {
    const c = classifyEmail({ fromAddress: 'dse_NA4@docusign.net', fromName: 'DocuSign' });
    expect(c.disposition).toBe('keep');
  });
});

describe('precedence — first match wins on overlapping inputs', () => {
  it('calendar beats a human display name', () => {
    const c = classifyEmail({
      fromAddress: 'rolf.haag@tereina.com',
      fromName: 'Rolf Haag',
      headers: [{ name: 'Content-Class', value: 'urn:content-classes:calendarmessage' }],
    });
    expect(c.source).toBe('calendar');
  });
  it('automated beats a human display name for a role address', () => {
    expect(classifyEmail({ fromAddress: 'updates@company.com', fromName: 'Company Updates' }).source).toBe('automated');
  });
  it('github beats the automated pattern for notifications@github.com', () => {
    expect(
      classifyEmail({ fromAddress: 'notifications@github.com', headers: [{ name: 'X-GitHub-Reason', value: 'subscribed' }], bodyPreview: 'x' }).source,
    ).toBe('github');
  });
});

describe('missing/empty fields', () => {
  it('a bare address with no subject/headers/body → unknown, keep', () => {
    const c = classifyEmail({ fromAddress: 'someone@nowhere.test' });
    expect(c.source).toBe('unknown');
    expect(c.disposition).toBe('keep');
  });
});

describe('decideAction', () => {
  const fileCls = classifyEmail({
    fromAddress: 'notifications@github.com',
    headers: [{ name: 'X-GitHub-Reason', value: 'subscribed' }],
    bodyPreview: 'merged',
  }); // github noise → file
  const uncertainCls = classifyEmail({ fromAddress: 'x@vendor.io' }); // unknown → keep + uncertain
  const humanCls = classifyEmail({ fromAddress: 'rolf.haag@tereina.com', fromName: 'Rolf' }); // keep, confident

  it('files only when live AND the source is enabled', () => {
    expect(decideAction(fileCls, { dryRun: false, fileSources: ['github'] })).toEqual({ file: true, tag: false });
    expect(decideAction(fileCls, { dryRun: false, fileSources: ['jira'] }).file).toBe(false); // source off
    expect(decideAction(fileCls, { dryRun: true, fileSources: ['github'] }).file).toBe(false); // dry-run
    expect(decideAction(fileCls, { dryRun: false, fileSources: [] }).file).toBe(false); // fail-safe default
  });

  it('tags an uncertain keep only when live, never files it', () => {
    expect(decideAction(uncertainCls, { dryRun: false, fileSources: [] })).toEqual({ file: false, tag: true });
    expect(decideAction(uncertainCls, { dryRun: true, fileSources: [] }).tag).toBe(false);
  });

  it('does nothing for a confident keep (human)', () => {
    expect(decideAction(humanCls, { dryRun: false, fileSources: ['github', 'jira'] })).toEqual({ file: false, tag: false });
  });
});
