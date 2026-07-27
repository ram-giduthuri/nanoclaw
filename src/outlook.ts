import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { isOutlookProcessed, markOutlookProcessed } from './db.js';
import {
  hasM365Credentials,
  graphGet,
  graphPost,
  graphPatch,
} from './m365-auth.js';
import { ASSISTANT_NAME, TIMEZONE } from './config.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { classifyEmail, decideAction } from './email-classifier.js';

// Single folder for all auto-filed noise.
const NANOCLAW_FOLDER = 'NanoClaw - outlook-main';
// In-place tag (no move) on kept mail with no precise rule. Filed mail isn't tagged.
const REVIEW_CATEGORY = 'NanoClaw Review';
const NANOCLAW_CATEGORIES: Array<{ name: string; color: string }> = [
  { name: REVIEW_CATEGORY, color: 'preset6' }, // purple
];

// Dry-run (default): classify + log but never mutate. Set M365_OUTLOOK_DRY_RUN=false to go live.
function isDryRun(): boolean {
  const env = readEnvFile(['M365_OUTLOOK_DRY_RUN']);
  return env.M365_OUTLOOK_DRY_RUN !== 'false';
}

// Sources filed when live (roll out one at a time). Fail-safe: unset = file nothing.
function getFileSources(): string[] {
  const raw = readEnvFile([
    'M365_OUTLOOK_FILE_SOURCES',
  ]).M365_OUTLOOK_FILE_SOURCES;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// User's GitHub login, for @mention detection.
function getGithubHandle(): string | undefined {
  return readEnvFile(['GITHUB_HANDLE']).GITHUB_HANDLE || undefined;
}

// --- Types ---

interface OutlookMessage {
  id: string;
  conversationId: string;
  internetMessageId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  ccRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  isRead: boolean;
  parentFolderId: string;
  inferenceClassification?: 'focused' | 'other';
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  categories?: string[];
}

interface MailFolder {
  id: string;
  displayName: string;
}

interface AliasMapping {
  alias: string;
  groupFolder: string;
}

interface OutlookLoopOpts {
  storeMessage: (msg: NewMessage) => void;
  storeChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  runEmailAgent: (
    groupFolder: string,
    chatJid: string,
    prompt: string,
  ) => Promise<string | null>;
  sendToMainChannel: (text: string) => Promise<void>;
  // DB accessors for email thread tracking
  getEmailThread: (threadId: string) => EmailThread | undefined;
  upsertEmailThread: (thread: EmailThread) => void;
}

export interface EmailThread {
  thread_id: string;
  alias: string;
  group_folder: string;
  subject: string | null;
  last_message_id: string | null;
  created_at: string;
}

// --- Alias config parsing ---

function parseAliases(): AliasMapping[] {
  const env = readEnvFile(['M365_OUTLOOK_ALIASES']);
  const raw = env.M365_OUTLOOK_ALIASES;
  if (!raw) return [];

  return raw
    .split(',')
    .map((entry) => {
      const [alias, groupFolder] = entry.trim().split(':');
      return { alias: alias.toLowerCase(), groupFolder };
    })
    .filter((m) => m.alias && m.groupFolder);
}

function getOutlookMode(): 'alias' | 'all' {
  const env = readEnvFile(['M365_OUTLOOK_MODE']);
  return env.M365_OUTLOOK_MODE === 'all' ? 'all' : 'alias';
}

function getDefaultGroup(): string {
  const env = readEnvFile(['M365_OUTLOOK_DEFAULT_GROUP']);
  return env.M365_OUTLOOK_DEFAULT_GROUP || 'email-default';
}

function getPollInterval(): number {
  const env = readEnvFile(['M365_OUTLOOK_POLL_INTERVAL']);
  return parseInt(env.M365_OUTLOOK_POLL_INTERVAL || '60000', 10);
}

// --- JID helpers ---

function outlookJid(alias: string): string {
  return `outlook:${alias.toLowerCase()}`;
}

function defaultOutlookJid(): string {
  return 'outlook:default';
}

// --- Subfolder management ---

const folderIdCache = new Map<string, string>();

async function ensureMailFolder(displayName: string): Promise<string> {
  const cached = folderIdCache.get(displayName);
  if (cached) return cached;

  // Check if folder exists
  try {
    const result = await graphGet<{ value: MailFolder[] }>(
      `/me/mailFolders?$filter=displayName eq '${displayName}'`,
    );
    if (result.value?.length > 0) {
      folderIdCache.set(displayName, result.value[0].id);
      return result.value[0].id;
    }
  } catch (err) {
    logger.warn({ displayName, err }, 'Failed to check mail folder');
  }

  // Create folder
  try {
    const folder = await graphPost<MailFolder>('/me/mailFolders', {
      displayName,
    });
    folderIdCache.set(displayName, folder.id);
    logger.info({ displayName }, 'Created Outlook mail folder');
    return folder.id;
  } catch (err) {
    logger.error({ displayName, err }, 'Failed to create mail folder');
    throw err;
  }
}

async function moveToFolder(
  messageId: string,
  folderId: string,
): Promise<void> {
  try {
    await graphPost(`/me/messages/${messageId}/move`, {
      destinationId: folderId,
    });
  } catch (err) {
    logger.warn({ messageId, folderId, err }, 'Failed to move email to folder');
  }
}

async function markAsRead(messageId: string): Promise<void> {
  try {
    await graphPatch(`/me/messages/${messageId}`, { isRead: true });
  } catch (err) {
    logger.warn({ messageId, err }, 'Failed to mark email as read');
  }
}

async function assignCategories(
  messageId: string,
  categories: string[],
): Promise<void> {
  try {
    // PATCH replaces the whole array — callers pass the full desired set.
    await graphPatch(`/me/messages/${messageId}`, { categories });
  } catch (err) {
    logger.warn({ messageId, categories, err }, 'Failed to tag email');
  }
}

// Ensure our category exists in the master list (for a consistent color). Idempotent.
async function ensureCategories(): Promise<void> {
  try {
    const existing = await graphGet<{ value: Array<{ displayName: string }> }>(
      '/me/outlook/masterCategories',
    );
    const have = new Set(
      (existing.value || []).map((c) => c.displayName.toLowerCase()),
    );
    for (const cat of NANOCLAW_CATEGORIES) {
      if (have.has(cat.name.toLowerCase())) continue;
      try {
        await graphPost('/me/outlook/masterCategories', {
          displayName: cat.name,
          color: cat.color,
        });
        logger.info({ category: cat.name }, 'Created Outlook master category');
      } catch (err) {
        logger.warn({ category: cat.name, err }, 'Failed to create category');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to provision master categories (non-fatal)');
  }
}

// File a message: mark read, then move. /move returns a new id, so it's last.
async function fileEmail(
  messageId: string,
  folderId: string | undefined,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  await markAsRead(messageId);
  if (folderId) await moveToFolder(messageId, folderId);
}

// --- Email classification ---
// Sender/automation classification now lives in email-classifier.ts.

function classifyByAlias(
  msg: OutlookMessage,
  aliases: AliasMapping[],
): AliasMapping | null {
  // Check the resolved toRecipients/ccRecipients first
  const allRecipients = [
    ...msg.toRecipients.map((r) => r.emailAddress.address.toLowerCase()),
    ...msg.ccRecipients.map((r) => r.emailAddress.address.toLowerCase()),
  ];

  for (const mapping of aliases) {
    if (allRecipients.includes(mapping.alias)) {
      return mapping;
    }
  }

  // Exchange rewrites alias addresses to the primary SMTP address in toRecipients.
  // Check the raw internet message headers (To/CC) which preserve the original alias.
  if (msg.internetMessageHeaders) {
    const rawTo =
      msg.internetMessageHeaders
        .filter(
          (h) => h.name.toLowerCase() === 'to' || h.name.toLowerCase() === 'cc',
        )
        .map((h) => h.value.toLowerCase())
        .join(' ') || '';

    for (const mapping of aliases) {
      if (rawTo.includes(mapping.alias)) {
        return mapping;
      }
    }
  }

  return null;
}

// --- Email content formatting ---

function stripHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function formatEmailAsPrompt(
  msg: OutlookMessage,
  alias: string,
  threadMessages?: OutlookMessage[],
): string {
  const lines: string[] = [];

  // Thread history
  if (threadMessages && threadMessages.length > 0) {
    lines.push('## Email Thread History (oldest first)\n');
    for (let i = 0; i < threadMessages.length; i++) {
      const tm = threadMessages[i];
      const body =
        tm.body.contentType === 'html'
          ? stripHtmlToText(tm.body.content)
          : tm.body.content;
      lines.push(
        `[${i + 1}] From: ${tm.from.emailAddress.name} <${tm.from.emailAddress.address}> | Date: ${tm.receivedDateTime}`,
      );
      lines.push(body.slice(0, 2000));
      lines.push('');
    }
    lines.push('---\n');
  }

  lines.push('## New Email\n');
  lines.push(
    `- From: ${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`,
  );
  lines.push(
    `- To: ${msg.toRecipients.map((r) => `${r.emailAddress.name} <${r.emailAddress.address}>`).join(', ')}`,
  );
  if (msg.ccRecipients.length > 0) {
    lines.push(
      `- CC: ${msg.ccRecipients.map((r) => `${r.emailAddress.name} <${r.emailAddress.address}>`).join(', ')}`,
    );
  }
  lines.push(`- Subject: ${msg.subject}`);
  lines.push(`- Date: ${msg.receivedDateTime}`);
  lines.push(`- Message-ID: ${msg.internetMessageId}`);
  lines.push(`- Your alias: ${alias}`);
  lines.push('');

  const body =
    msg.body.contentType === 'html'
      ? stripHtmlToText(msg.body.content)
      : msg.body.content;
  lines.push(body.slice(0, 5000));

  // Reply instructions
  lines.push('\n---');
  lines.push(`To reply to this email, use the draft_outlook_email tool with:`);
  lines.push(`- from_alias: ${alias}`);
  lines.push(`- to: ${msg.from.emailAddress.address}`);
  const ccAddrs = [...msg.toRecipients, ...msg.ccRecipients]
    .map((r) => r.emailAddress.address)
    .filter(
      (a) =>
        a.toLowerCase() !== alias.toLowerCase() &&
        a.toLowerCase() !== msg.from.emailAddress.address.toLowerCase(),
    );
  if (ccAddrs.length > 0) {
    lines.push(`- cc: ${ccAddrs.join(', ')}`);
  }
  lines.push(`- subject: Re: ${msg.subject.replace(/^Re:\s*/i, '')}`);
  lines.push(`- in_reply_to: ${msg.id}`);
  lines.push(`- conversation_id: ${msg.conversationId}`);

  return lines.join('\n');
}

// --- Outbound email ---

export async function sendOutlookEmail(params: {
  fromAlias: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  conversationId?: string;
}): Promise<void> {
  // If replying to an existing message, use the reply endpoint to preserve thread history
  if (params.inReplyTo) {
    await graphPost(`/me/messages/${params.inReplyTo}/reply`, {
      comment: params.body,
    });

    logger.info(
      {
        from: params.fromAlias,
        to: params.to,
        subject: params.subject,
        replyTo: params.inReplyTo,
      },
      'Sent Outlook reply (with thread history)',
    );
    return;
  }

  // New message (not a reply)
  const message: Record<string, unknown> = {
    subject: params.subject,
    body: { contentType: 'text', content: params.body },
    from: {
      emailAddress: { address: params.fromAlias },
    },
    toRecipients: params.to.map((addr) => ({
      emailAddress: { address: addr },
    })),
  };

  if (params.cc?.length) {
    message.ccRecipients = params.cc.map((addr) => ({
      emailAddress: { address: addr },
    }));
  }

  if (params.conversationId) {
    message.conversationId = params.conversationId;
  }

  await graphPost('/me/sendMail', {
    message,
    saveToSentItems: true,
  });

  logger.info(
    { from: params.fromAlias, to: params.to, subject: params.subject },
    'Sent Outlook email',
  );
}

export async function draftOutlookEmail(params: {
  fromAlias: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  conversationId?: string;
}): Promise<string> {
  // If replying, use createReply to preserve thread history
  if (params.inReplyTo) {
    const replyDraft = await graphPost<{ id: string }>(
      `/me/messages/${params.inReplyTo}/createReply`,
      { comment: params.body },
    );

    logger.info(
      {
        from: params.fromAlias,
        to: params.to,
        subject: params.subject,
        draftId: replyDraft.id,
        replyTo: params.inReplyTo,
      },
      'Saved Outlook reply draft (with thread history)',
    );

    return replyDraft.id;
  }

  // New message (not a reply)
  const message: Record<string, unknown> = {
    subject: params.subject,
    body: { contentType: 'text', content: params.body },
    from: {
      emailAddress: { address: params.fromAlias },
    },
    toRecipients: params.to.map((addr) => ({
      emailAddress: { address: addr },
    })),
  };

  if (params.cc?.length) {
    message.ccRecipients = params.cc.map((addr) => ({
      emailAddress: { address: addr },
    }));
  }

  if (params.conversationId) {
    message.conversationId = params.conversationId;
  }

  const draft = await graphPost<{ id: string }>('/me/messages', message);

  logger.info(
    {
      from: params.fromAlias,
      to: params.to,
      subject: params.subject,
      draftId: draft.id,
    },
    'Saved Outlook draft',
  );

  return draft.id;
}

// --- Email search (used by IPC) ---

export interface EmailSearchParams {
  query?: string;
  from?: string;
  subject?: string;
  after?: string;
  before?: string;
  top?: number;
}

export interface EmailSearchResult {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  to: string[];
  receivedDateTime: string;
  bodyPreview: string;
  conversationId: string;
}

export async function searchOutlookEmails(
  params: EmailSearchParams,
): Promise<EmailSearchResult[]> {
  const top = Math.min(params.top || 20, 50);
  const filters: string[] = [];

  if (params.from) {
    filters.push(`from/emailAddress/address eq '${params.from}'`);
  }
  if (params.subject) {
    filters.push(`contains(subject, '${params.subject}')`);
  }
  if (params.after) {
    filters.push(`receivedDateTime ge ${params.after}`);
  }
  if (params.before) {
    filters.push(`receivedDateTime le ${params.before}`);
  }

  let url: string;
  if (params.query && filters.length === 0) {
    // Use $search for free-text
    url = `/me/messages?$search="${encodeURIComponent(params.query)}"&$top=${top}&$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId`;
  } else if (filters.length > 0) {
    const filterStr = filters.join(' and ');
    url = `/me/messages?$filter=${filterStr}&$orderby=receivedDateTime desc&$top=${top}&$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId`;
  } else {
    url = `/me/messages?$orderby=receivedDateTime desc&$top=${top}&$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId`;
  }

  const result = await graphGet<{ value: OutlookMessage[] }>(url);
  return (result.value || []).map((m) => ({
    id: m.id,
    subject: m.subject,
    from: m.from.emailAddress.address,
    fromName: m.from.emailAddress.name,
    to: m.toRecipients.map((r) => r.emailAddress.address),
    receivedDateTime: m.receivedDateTime,
    bodyPreview: m.bodyPreview,
    conversationId: m.conversationId,
  }));
}

// --- Main polling loop ---

export async function startOutlookLoop(opts: OutlookLoopOpts): Promise<void> {
  if (!hasM365Credentials()) {
    logger.debug('M365 credentials not configured, skipping Outlook loop');
    return;
  }

  const aliases = parseAliases();
  const mode = getOutlookMode();
  const defaultGroup = getDefaultGroup();
  const pollMs = getPollInterval();

  if (mode === 'alias' && aliases.length === 0) {
    logger.warn(
      'M365_OUTLOOK_MODE=alias but no aliases configured (M365_OUTLOOK_ALIASES). Skipping Outlook loop.',
    );
    return;
  }

  // Ensure the single destination folder + tag categories exist. Classification
  // (not the alias) now decides what gets filed here.
  let nanoclawFolderId: string | undefined;
  try {
    nanoclawFolderId = await ensureMailFolder(NANOCLAW_FOLDER);
  } catch {
    // Non-fatal — emails will still be classified, just not moved.
  }
  await ensureCategories();

  // Register system groups for each alias
  for (const mapping of aliases) {
    const jid = outlookJid(mapping.alias);
    const existing = opts.registeredGroups();
    if (!existing[jid]) {
      opts.registerGroup(jid, {
        name: `Outlook ${mapping.alias}`,
        folder: mapping.groupFolder,
        trigger: 'all',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
    }
  }

  // Register default group if mode=all
  if (mode === 'all') {
    const jid = defaultOutlookJid();
    const existing = opts.registeredGroups();
    if (!existing[jid]) {
      opts.registerGroup(jid, {
        name: 'Outlook Default',
        folder: defaultGroup,
        trigger: 'all',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
    }
  }

  logger.info(
    {
      mode,
      aliasCount: aliases.length,
      pollMs,
      aliases: aliases.map((a) => a.alias),
    },
    'Starting Outlook email loop',
  );

  // Backfill recent emails so the DB isn't empty on first run (paginated)
  try {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    let backfillCount = 0;
    let nextUrl: string | undefined =
      `/me/messages?$filter=receivedDateTime ge ${sevenDaysAgo}&$top=200&$orderby=receivedDateTime asc&$select=id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,parentFolderId`;

    while (nextUrl) {
      const backfillResult: {
        value: OutlookMessage[];
        '@odata.nextLink'?: string;
      } = await graphGet(nextUrl);
      const backfillMessages = backfillResult.value || [];

      for (const msg of backfillMessages) {
        markOutlookProcessed(msg.id); // Prevent pollInbox from re-triggering agent

        // Skip messages without a sender (drafts, system messages, etc.)
        if (!msg.from?.emailAddress) continue;

        const aliasMatch = classifyByAlias(msg, aliases);
        if (!aliasMatch && mode === 'alias') continue;

        const targetAlias = aliasMatch?.alias || 'default';
        const chatJid = aliasMatch
          ? outlookJid(aliasMatch.alias)
          : defaultOutlookJid();

        // Track thread
        let thread = opts.getEmailThread(msg.conversationId);
        if (!thread) {
          thread = {
            thread_id: msg.conversationId,
            alias: targetAlias,
            group_folder: aliasMatch?.groupFolder || defaultGroup,
            subject: msg.subject,
            last_message_id: msg.internetMessageId,
            created_at: new Date().toISOString(),
          };
          opts.upsertEmailThread(thread);
        }

        // Ensure chat exists before storing message (FK constraint)
        opts.storeChatMetadata(
          chatJid,
          msg.receivedDateTime,
          `Outlook ${targetAlias}`,
          'outlook',
          false,
        );
        opts.storeMessage({
          id: msg.id,
          chat_jid: chatJid,
          sender: msg.from.emailAddress.address,
          sender_name: msg.from.emailAddress.name,
          content: `[Email] ${msg.subject}\n\n${msg.bodyPreview}`,
          timestamp: msg.receivedDateTime,
          is_from_me: false,
          is_bot_message: false,
        });
        backfillCount++;
      }

      // Follow pagination link if there are more results
      nextUrl = backfillResult['@odata.nextLink'];
    }

    if (backfillCount > 0) {
      logger.info(
        { backfillCount },
        'Backfilled recent emails into messages DB',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Email backfill failed (non-fatal)');
  }

  async function pollInbox(): Promise<void> {
    try {
      const result = await graphGet<{ value: OutlookMessage[] }>(
        '/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=50&$orderby=receivedDateTime desc&$select=id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,parentFolderId,inferenceClassification,internetMessageHeaders,categories',
      );

      const messages = result.value || [];

      if (messages.length > 0) {
        logger.info(
          {
            unreadCount: messages.length,
            newCount: messages.filter((m) => !isOutlookProcessed(m.id)).length,
          },
          'Outlook poll: found unread emails',
        );
      }

      for (const msg of messages) {
        if (isOutlookProcessed(msg.id)) continue;

        // Skip senderless mail (NDRs/system) — dereferencing it would throw and
        // crash-loop the poll. Mirrors the backfill guard.
        if (!msg.from?.emailAddress || !msg.toRecipients) {
          markOutlookProcessed(msg.id);
          continue;
        }

        // Classify by alias
        const aliasMatch = classifyByAlias(msg, aliases);

        if (!aliasMatch && mode === 'alias') {
          logger.debug(
            { subject: msg.subject, from: msg.from.emailAddress.address },
            'Outlook: skipping non-alias email',
          );
          // Not addressed to any configured alias — mark processed in DB
          // so it won't reappear after restart
          markOutlookProcessed(msg.id);
          continue;
        }

        logger.info(
          {
            subject: msg.subject,
            from: msg.from.emailAddress.address,
            aliasMatched: aliasMatch?.alias || null,
          },
          'Outlook: processing email',
        );

        const targetAlias = aliasMatch?.alias || 'default';
        const targetFolder = aliasMatch?.groupFolder || defaultGroup;
        const chatJid = aliasMatch
          ? outlookJid(aliasMatch.alias)
          : defaultOutlookJid();

        // Check/update thread tracking
        let thread = opts.getEmailThread(msg.conversationId);
        if (!thread) {
          thread = {
            thread_id: msg.conversationId,
            alias: targetAlias,
            group_folder: targetFolder,
            subject: msg.subject,
            last_message_id: msg.internetMessageId,
            created_at: new Date().toISOString(),
          };
          opts.upsertEmailThread(thread);
        } else {
          // Use existing thread's routing (thread continuity)
          thread.last_message_id = msg.internetMessageId;
          opts.upsertEmailThread(thread);
        }

        // Fetch thread context
        let threadMessages: OutlookMessage[] = [];
        try {
          const threadResult = await graphGet<{ value: OutlookMessage[] }>(
            `/me/messages?$filter=conversationId eq '${msg.conversationId}'&$top=20&$select=id,body,from,toRecipients,ccRecipients,receivedDateTime,internetMessageId`,
          );
          // Exclude the current message, sort by date ascending (client-side)
          threadMessages = (threadResult.value || [])
            .filter((tm) => tm.id !== msg.id)
            .sort((a, b) =>
              a.receivedDateTime.localeCompare(b.receivedDateTime),
            );
        } catch (err) {
          logger.warn(
            { conversationId: msg.conversationId, err },
            'Failed to fetch email thread',
          );
        }

        // Build prompt
        const prompt = formatEmailAsPrompt(msg, targetAlias, threadMessages);

        // Store as message in DB
        const storedMsg: NewMessage = {
          id: msg.id,
          chat_jid: chatJid,
          sender: msg.from.emailAddress.address,
          sender_name: msg.from.emailAddress.name,
          content: `[Email] ${msg.subject}\n\n${msg.bodyPreview}`,
          timestamp: msg.receivedDateTime,
          is_from_me: false,
          is_bot_message: false,
        };
        // Ensure chat exists before storing message (FK constraint)
        opts.storeChatMetadata(
          chatJid,
          msg.receivedDateTime,
          `Outlook ${targetAlias}`,
          'outlook',
          false,
        );
        opts.storeMessage(storedMsg);

        // Store only — no automatic agent runs.
        // All actions (drafting replies, etc.) must be explicitly requested
        // from the main Teams channel.
        markOutlookProcessed(msg.id);

        // Only high-confidence dev noise files; everything else stays in the inbox.
        const classification = classifyEmail({
          fromAddress: msg.from.emailAddress.address,
          fromName: msg.from.emailAddress.name,
          subject: msg.subject,
          bodyPreview: msg.bodyPreview,
          headers: msg.internetMessageHeaders,
          githubHandle: getGithubHandle(),
        });
        const action = decideAction(classification, {
          dryRun: isDryRun(),
          fileSources: getFileSources(),
        });

        if (classification.disposition === 'file') {
          logger.info(
            {
              subject: msg.subject,
              from: msg.from.emailAddress.address,
              source: classification.source,
              githubReason: classification.githubReason,
              applied: action.file,
            },
            action.file
              ? 'Outlook: filing email'
              : 'Outlook: would file email (not applied)',
          );
          await fileEmail(msg.id, nanoclawFolderId, !action.file);
        } else {
          // Tag (no move) uncertain keeps; union with existing categories so none are wiped.
          if (action.tag) {
            const existing = msg.categories || [];
            if (!existing.includes(REVIEW_CATEGORY)) {
              await assignCategories(msg.id, [...existing, REVIEW_CATEGORY]);
            }
          }
          logger.debug(
            {
              subject: msg.subject,
              from: msg.from.emailAddress.address,
              source: classification.source,
              tagged: action.tag,
            },
            'Outlook: keeping email in inbox',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Outlook inbox poll error');
    }
  }

  // Initial poll
  await pollInbox();

  // Recurring poll
  setInterval(() => {
    pollInbox().catch((err) =>
      logger.error({ err }, 'Outlook poll cycle error'),
    );
  }, pollMs);
}
