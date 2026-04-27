/**
 * huly-worker.js — background poller for Huly AI automation
 *
 * Two loops, both no-ops unless HULY_URL/WORKSPACE/credentials are set:
 *
 *   Status loop (every HULY_POLL_STATUS_MS):
 *     - Lists issues in status "AI - to do" across all (or filtered) projects
 *     - Runs the AI handler against each, posts result as a Huly comment
 *     - Moves the issue to "AI - done"
 *
 *   Comment loop (every HULY_POLL_COMMENTS_MS):
 *     - Scans recent issues for new comments starting with /ai (incl. canned
 *       sub-commands /ai summarize|plan|risks|draft|review and free-form)
 *     - Posts an AI reply as a Huly comment
 *     - Tracks processed comment IDs in memory to avoid duplicates
 */

import {
  HULY_ENABLED,
  HULY_POLL_STATUS_MS,
  HULY_POLL_COMMENTS_MS,
  HULY_STATUS_TODO,
  HULY_STATUS_DONE,
  nowMoscow,
} from './config.js';
import {
  getHulyClient,
  closeHulyClient,
  listProjects,
  findIssuesByStatusName,
  moveIssueToStatus,
  getIssueDescriptionMarkdown,
  postIssueComment,
  listIssueComments,
  markupToPlainText,
  HULY_CLASS,
} from './huly-client.js';
import { handleAI, isAICommand } from './ai-handler.js';
import { callLLM } from './llm-client.js';
import { createHulyAdapter } from './platform.js';

const AI_MARKER = '<!-- ai-analysis -->';

// In-memory dedupe state. Reset on process restart — that's fine: the AI
// marker comment also helps prevent repeats within the same loop, and the
// status transition (AI - to do → AI - done) is naturally idempotent.
const processedCommentIds = new Set();
const processedIssueRunsAt = new Map(); // issueId → ts of last AI run
const COMMENT_DEDUPE_MAX = 5000;
const ISSUE_DEDUPE_MAX = 1000;

function rememberComment(id) {
  processedCommentIds.add(id);
  if (processedCommentIds.size > COMMENT_DEDUPE_MAX) {
    // drop oldest by recreating from the tail
    const arr = [...processedCommentIds].slice(-COMMENT_DEDUPE_MAX);
    processedCommentIds.clear();
    arr.forEach((x) => processedCommentIds.add(x));
  }
}

function rememberIssueRun(id) {
  processedIssueRunsAt.set(id, Date.now());
  if (processedIssueRunsAt.size > ISSUE_DEDUPE_MAX) {
    const oldest = [...processedIssueRunsAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 200);
    for (const [k] of oldest) processedIssueRunsAt.delete(k);
  }
}

// ─── AI processing for status trigger ────────────────────────────────────────

/**
 * Run the AI on an issue's title + description and return a markdown reply.
 * Generic, non-templated: works for any task the user puts in "AI - to do".
 */
async function runAIOnIssue(issue, descriptionMd) {
  const title = issue.title || '';
  const messages = [
    {
      role: 'system',
      content:
        'Ты AI-ассистент в kanban-системе Huly. Тебе передают задачу, которую пользователь хочет, чтобы ты выполнил. ' +
        'Ответ давай по-русски. Будь предметным, структурируй ответ markdown-ом (заголовки, списки, таблицы — по необходимости). ' +
        'Если задача — резюме / план / риски / черновик / ревью — сделай именно это. ' +
        'Если из заголовка и описания не понятно, что от тебя хотят — выполни задачу буквально и в конце укажи допущения.',
    },
    {
      role: 'user',
      content: `Заголовок задачи:\n${title}\n\nОписание:\n${descriptionMd || '(пусто)'}\n\n` +
        'Сделай то, что просит задача.',
    },
  ];
  const reply = await callLLM(messages, { maxTokens: 2000, temperature: 0.4 });
  return reply;
}

/**
 * Process one "AI - to do" issue end-to-end.
 */
async function processTodoIssue(project, issue) {
  const key = `${project.identifier}-${issue.number || issue._id}`;
  const lastRun = processedIssueRunsAt.get(issue._id);
  // Re-run if not seen for >2× poll interval (safety against stuck items)
  if (lastRun && Date.now() - lastRun < HULY_POLL_STATUS_MS * 2) {
    return;
  }
  rememberIssueRun(issue._id);

  console.log(`[huly-worker] processing AI todo: ${key} "${issue.title}"`);

  const descriptionMd = await getIssueDescriptionMarkdown(issue);

  const startedComment = `${AI_MARKER}\n## 🤖 AI обрабатывает задачу...\n\n*${nowMoscow()}*`;
  try {
    await postIssueComment(issue, startedComment);
  } catch (err) {
    console.warn(`[huly-worker] could not post 'thinking' comment on ${key}: ${err.message}`);
  }

  let answer;
  try {
    answer = await runAIOnIssue(issue, descriptionMd);
  } catch (err) {
    console.error(`[huly-worker] AI call failed for ${key}: ${err.message}`);
    answer = null;
  }

  const resultBody = answer
    ? `${AI_MARKER}\n## 🤖 AI-ответ\n\n*${nowMoscow()}*\n\n${answer}`
    : `${AI_MARKER}\n## ❌ AI недоступен\n\nНе удалось получить ответ от AI. Попробуйте позже.`;

  try {
    await postIssueComment(issue, resultBody);
  } catch (err) {
    console.error(`[huly-worker] could not post result comment on ${key}: ${err.message}`);
    return; // don't move to Done if we never delivered the answer
  }

  // Move to AI - done (best effort)
  try {
    const moved = await moveIssueToStatus(issue, project, HULY_STATUS_DONE);
    if (moved) {
      console.log(`[huly-worker] ${key} → "${HULY_STATUS_DONE}"`);
    } else {
      console.warn(`[huly-worker] could not move ${key} to "${HULY_STATUS_DONE}" (status not found in project)`);
    }
  } catch (err) {
    console.error(`[huly-worker] move to Done failed for ${key}: ${err.message}`);
  }
}

// ─── Status sweep ────────────────────────────────────────────────────────────

let statusSweepRunning = false;
async function statusSweep() {
  if (statusSweepRunning) return;
  statusSweepRunning = true;
  try {
    const projects = await listProjects();
    if (projects.length === 0) {
      console.log('[huly-worker] status sweep: no accessible projects');
      return;
    }
    for (const project of projects) {
      let issues;
      try {
        issues = await findIssuesByStatusName(project, HULY_STATUS_TODO);
      } catch (err) {
        console.warn(`[huly-worker] findIssuesByStatusName failed for ${project.identifier}: ${err.message}`);
        continue;
      }
      if (!issues.length) continue;
      console.log(`[huly-worker] ${project.identifier}: ${issues.length} issue(s) in "${HULY_STATUS_TODO}"`);
      for (const issue of issues) {
        try {
          await processTodoIssue(project, issue);
        } catch (err) {
          console.error(`[huly-worker] processTodoIssue error: ${err.message}`, err.stack);
        }
      }
    }
  } catch (err) {
    console.error(`[huly-worker] statusSweep error: ${err.message}`, err.stack);
  } finally {
    statusSweepRunning = false;
  }
}

// ─── Comment sweep ───────────────────────────────────────────────────────────

/**
 * Pre-canned /ai sub-commands. The user's task only requires that comments
 * starting with /ai (and these specific sub-commands) work; for anything we
 * don't recognise, fall back to free-form Q&A handled by ai-handler.handleAI.
 */
const AI_SUBCOMMAND_PROMPTS = {
  summarize: 'Сделай краткое резюме задачи (3–6 пунктов): суть, контекст, риски, что нужно решить.',
  plan: 'Составь пошаговый план реализации задачи. Минимум 5 шагов, с указанием артефактов и проверок.',
  risks: 'Перечисли риски этой задачи. Для каждого риска: вероятность, влияние, митигатор.',
  draft: 'Подготовь черновик результата по этой задаче (например: текст, письмо, документ, кусок кода — что уместно).',
  review: 'Сделай review задачи: проверь полноту описания, наличие критериев готовности (DoD), исполнителя, дедлайна, рисков.',
};

function parseAISubcommand(body) {
  const m = body.match(/^\s*\/ai\s+(summarize|plan|risks|draft|review)(?:\s+|\s*$)(.*)/is);
  if (!m) return null;
  return { name: m[1].toLowerCase(), extra: (m[2] || '').trim() };
}

async function answerCanned({ issue, sub, descriptionMd }) {
  const basePrompt = AI_SUBCOMMAND_PROMPTS[sub.name];
  const extra = sub.extra ? `\n\nДополнительно от пользователя:\n${sub.extra}` : '';
  const messages = [
    {
      role: 'system',
      content:
        'Ты AI-ассистент в kanban-системе Huly. Отвечай по-русски, кратко и по делу, в markdown.',
    },
    {
      role: 'user',
      content:
        `${basePrompt}${extra}\n\nЗадача:\nЗаголовок: ${issue.title || ''}\n\nОписание:\n${descriptionMd || '(пусто)'}`,
    },
  ];
  return callLLM(messages, { maxTokens: 1500, temperature: 0.4 });
}

async function processNewComment({ project, issue, comment }) {
  const text = markupToPlainText(comment.message);
  if (!text) return;
  if (!isAICommand(text)) return;
  if (text.includes(AI_MARKER)) return; // our own comment

  rememberComment(comment._id);

  const sub = parseAISubcommand(text);
  const platform = createHulyAdapter({ issue, project });

  // Ensure ai-handler can read description as text
  const descriptionMd = await getIssueDescriptionMarkdown(issue);
  const issueForAI = {
    title: issue.title || '',
    body: descriptionMd || '',
  };

  if (!sub) {
    // Free-form /ai or /ai <question> — delegate to existing ai-handler
    return handleAI({ issue: issueForAI, platform, commentBody: text });
  }

  // Canned sub-command path — write our own comment so users see the
  // sub-command name in the header.
  const thinking = `${AI_MARKER}\n## 🤖 AI обрабатывает /ai ${sub.name}...\n\n*${nowMoscow()}*`;
  await postIssueComment(issue, thinking).catch(() => {});

  let answer;
  try {
    answer = await answerCanned({ issue, sub, descriptionMd });
  } catch (err) {
    console.error(`[huly-worker] canned /ai ${sub.name} failed: ${err.message}`);
    answer = null;
  }

  const reply = answer
    ? `${AI_MARKER}\n## 🤖 /ai ${sub.name}\n\n*${nowMoscow()}*\n\n${answer}`
    : `${AI_MARKER}\n## ❌ AI недоступен\n\nНе удалось выполнить /ai ${sub.name}.`;

  await postIssueComment(issue, reply).catch((err) => {
    console.error(`[huly-worker] could not post /ai ${sub.name} reply: ${err.message}`);
  });
}

let commentSweepRunning = false;
async function commentSweep() {
  if (commentSweepRunning) return;
  commentSweepRunning = true;
  try {
    const client = await getHulyClient();
    if (!client) return;

    const projects = await listProjects();
    if (projects.length === 0) return;

    // Fetch recent comments globally then group by issue. Limiting to
    // the last 200 newest ChatMessage docs across the workspace keeps the
    // sweep cheap while still catching anything posted in the last few mins.
    let recentComments;
    try {
      recentComments = await client.findAll(
        HULY_CLASS.ChatMessage,
        { attachedToClass: HULY_CLASS.Issue },
        { limit: 200, sort: { createdOn: -1 } },
      );
    } catch (err) {
      console.warn(`[huly-worker] comment sweep findAll failed: ${err.message}`);
      return;
    }

    const projectIds = new Set(projects.map((p) => p._id));
    const fresh = recentComments.filter(
      (c) => !processedCommentIds.has(c._id) && projectIds.has(c.space),
    );
    if (fresh.length === 0) return;

    // Group by attachedTo (issue id); fetch each issue once
    const byIssue = new Map();
    for (const c of fresh) {
      if (!byIssue.has(c.attachedTo)) byIssue.set(c.attachedTo, []);
      byIssue.get(c.attachedTo).push(c);
    }

    for (const [issueId, comments] of byIssue.entries()) {
      const issue = await client.findOne(HULY_CLASS.Issue, { _id: issueId });
      if (!issue) {
        // Mark these as seen so we don't keep retrying
        comments.forEach((c) => rememberComment(c._id));
        continue;
      }
      const project = projects.find((p) => p._id === issue.space);
      if (!project) {
        comments.forEach((c) => rememberComment(c._id));
        continue;
      }
      for (const c of comments.sort((a, b) => (a.createdOn || 0) - (b.createdOn || 0))) {
        try {
          await processNewComment({ project, issue, comment: c });
        } catch (err) {
          console.error(`[huly-worker] processNewComment error: ${err.message}`, err.stack);
        }
        rememberComment(c._id);
      }
    }
  } catch (err) {
    console.error(`[huly-worker] commentSweep error: ${err.message}`, err.stack);
  } finally {
    commentSweepRunning = false;
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

let statusInterval = null;
let commentInterval = null;

/**
 * Prime the in-memory dedupe set with all existing /ai comments so we don't
 * answer historical comments on startup.
 */
async function primeCommentDedupe() {
  try {
    const client = await getHulyClient();
    if (!client) return;
    const comments = await client.findAll(
      HULY_CLASS.ChatMessage,
      { attachedToClass: HULY_CLASS.Issue },
      { limit: 500, sort: { createdOn: -1 } },
    );
    for (const c of comments) processedCommentIds.add(c._id);
    console.log(`[huly-worker] primed dedupe with ${comments.length} existing comments`);
  } catch (err) {
    console.warn(`[huly-worker] could not prime dedupe: ${err.message}`);
  }
}

/**
 * Start polling. No-op if Huly is not configured.
 */
export async function startHulyWorker() {
  if (!HULY_ENABLED) {
    console.log('[huly-worker] disabled (HULY_URL / HULY_WORKSPACE / credentials not set)');
    return;
  }

  try {
    await getHulyClient();
  } catch (err) {
    console.error(`[huly-worker] initial Huly connection failed: ${err.message} — worker will retry on each tick`);
  }

  await primeCommentDedupe();

  console.log(
    `[huly-worker] started (status every ${HULY_POLL_STATUS_MS}ms, comments every ${HULY_POLL_COMMENTS_MS}ms, ` +
      `todo="${HULY_STATUS_TODO}", done="${HULY_STATUS_DONE}")`,
  );

  // Run an initial sweep shortly after boot then on the cadence
  setTimeout(() => statusSweep().catch(() => {}), 5000);
  setTimeout(() => commentSweep().catch(() => {}), 7000);

  statusInterval = setInterval(() => statusSweep().catch(() => {}), HULY_POLL_STATUS_MS);
  commentInterval = setInterval(() => commentSweep().catch(() => {}), HULY_POLL_COMMENTS_MS);
}

export async function stopHulyWorker() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
  if (commentInterval) { clearInterval(commentInterval); commentInterval = null; }
  await closeHulyClient();
}
