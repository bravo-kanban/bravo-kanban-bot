/**
 * move-handler.js — /move command handler with status transitions
 *
 * Validates transition rules, updates GitHub Projects V2 status via GraphQL,
 * and posts role-based AI trigger comments.
 */

import {
  STATUSES,
  STATUS_FORWARD_ORDER,
  PROJECT_ID,
  STATUS_FIELD_ID,
  AI_ROLE_TRIGGERS,
  nowMoscow,
  getProjectConfig,
} from './config.js';
import {
  getProjectItemForIssue,
  getStatusFieldOptions,
  updateProjectItemStatus,
  upsertBotComment,
  postComment,
  getIssueComments,
} from './github-client.js';
import { generateAITriggerLLM } from './llm-client.js';

const MOVE_MARKER = '<!-- move-result -->';

// Status option cache (per field ID)
const statusOptionsCache = new Map();

// ─── Parse /move command ──────────────────────────────────────────────────────

/**
 * Extract target status from a comment body.
 * Handles: /move "In Progress", /move in_progress, /move review, etc.
 * @param {string} body
 * @returns {string|null} normalized status name or null
 */
export function parseMoveCommand(body) {
  if (!body) return null;
  const match = body.match(/\/move\s+["«»'"]?([^"«»'"'\n\r]+?)["«»'"]?\s*$/im);
  if (!match) return null;

  const raw = match[1].trim().toLowerCase().replace(/_/g, ' ');
  return normalizeTargetStatus(raw);
}

function normalizeTargetStatus(raw) {
  if (raw.includes('backlog')) return 'Backlog';
  if (raw.includes('to do') || raw.includes('todo')) return 'To Do';
  if (raw.includes('in progress') || raw.includes('in_progress') || raw.includes('в работе') || raw.includes('в процессе')) return 'In Progress';
  if (raw.includes('review') || raw.includes('ревью') || raw.includes('проверка')) return 'Review';
  if (raw.includes('done') || raw.includes('готово') || raw.includes('завершено') || raw.includes('закрыто')) return 'Done';
  return null;
}

// ─── Resolve status option ID ─────────────────────────────────────────────────

async function resolveStatusOptionId(graphqlFn, targetStatus) {
  if (statusOptionsCache.has(STATUS_FIELD_ID)) {
    const opts = statusOptionsCache.get(STATUS_FIELD_ID);
    const opt = opts.find((o) => normalizeTargetStatus(o.name.toLowerCase()) === targetStatus);
    return opt?.id || null;
  }

  const options = await getStatusFieldOptions(graphqlFn, PROJECT_ID, STATUS_FIELD_ID);
  if (options.length > 0) {
    statusOptionsCache.set(STATUS_FIELD_ID, options);
  }

  const opt = options.find((o) => normalizeTargetStatus(o.name.toLowerCase()) === targetStatus);
  return opt?.id || null;
}

// ─── Transition validation ────────────────────────────────────────────────────

/**
 * Validate if a forward transition is allowed.
 * @param {string} from — current status
 * @param {string} to — target status
 * @param {object} issue
 * @param {Array} comments
 * @param {string} commenterLogin — login of person issuing /move
 * @returns {{ok: boolean, reason: string}}
 */
function validateTransition(from, to, issue, comments, commenterLogin) {
  const fromIdx = STATUS_FORWARD_ORDER[from] ?? 0;
  const toIdx = STATUS_FORWARD_ORDER[to] ?? 0;

  // Backward movement always allowed
  if (toIdx <= fromIdx) {
    return { ok: true, reason: `Откат из "${from}" в "${to}" разрешён` };
  }

  const title = issue.title || '';
  const body = issue.body || '';
  const assignees = issue.assignees || [];
  const assigneeLogin = assignees[0]?.login || null;
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name || ''));

  // → To Do
  if (to === 'To Do') {
    if (title.trim().length <= 5) return { ok: false, reason: 'Заголовок слишком короткий (≤5 символов)' };
    if (body.trim().length <= 30) return { ok: false, reason: 'Описание слишком короткое (≤30 символов)' };
    if (assignees.length === 0) return { ok: false, reason: 'Не назначен исполнитель' };
    if (labels.length === 0) return { ok: false, reason: 'Не указан тип задачи (label)' };
    return { ok: true, reason: 'Все условия для To Do выполнены' };
  }

  // → In Progress
  if (to === 'In Progress') {
    if (title.trim().length <= 5) return { ok: false, reason: 'Заголовок слишком короткий' };
    if (body.trim().length <= 30) return { ok: false, reason: 'Описание слишком короткое' };
    if (assignees.length === 0) return { ok: false, reason: 'Не назначен исполнитель' };
    if (labels.length === 0) return { ok: false, reason: 'Не указан тип задачи (label)' };
    if (assigneeLogin && commenterLogin && assigneeLogin !== commenterLogin) {
      return {
        ok: false,
        reason: `Только исполнитель (@${assigneeLogin}) может перевести задачу в In Progress`,
      };
    }
    return { ok: true, reason: 'Все условия для In Progress выполнены' };
  }

  // → Review
  if (to === 'Review') {
    if (assignees.length === 0) return { ok: false, reason: 'Не назначен исполнитель' };

    // Check for at least 1 comment from assignee about work done
    const assigneeComments = comments.filter(
      (c) => c.user?.login === assigneeLogin && !c.body?.includes(MOVE_MARKER),
    );
    if (assigneeComments.length === 0) {
      return {
        ok: false,
        reason: `Исполнитель (@${assigneeLogin}) ещё не оставил ни одного комментария о проделанной работе`,
      };
    }
    return { ok: true, reason: 'Все условия для Review выполнены' };
  }

  // → Done
  if (to === 'Done') {
    if (assignees.length === 0) return { ok: false, reason: 'Не назначен исполнитель' };

    // Check for confirmation from ANOTHER participant
    const DONE_KEYWORDS = ['ок', 'принято', 'approved', 'lgtm', 'подтверждаю', 'готово', 'done'];
    const hasConfirmation = comments.some((c) => {
      if (c.user?.login === commenterLogin) return false; // same person
      const bodyLower = (c.body || '').toLowerCase();
      return DONE_KEYWORDS.some((kw) => bodyLower.includes(kw));
    });

    if (!hasConfirmation) {
      return {
        ok: false,
        reason: 'Требуется подтверждение от другого участника ("Ок", "Принято", "Approved", "LGTM", "Подтверждаю")',
      };
    }
    return { ok: true, reason: 'Задача подтверждена и готова к закрытию' };
  }

  return { ok: true, reason: 'Переход разрешён' };
}

// ─── Determine role for AI trigger ───────────────────────────────────────────

function inferRole(issue) {
  const labels = (issue.labels || []).map((l) =>
    typeof l === 'string' ? l.toLowerCase() : (l.name || '').toLowerCase(),
  );
  const body = (issue.body || '').toLowerCase();
  const title = (issue.title || '').toLowerCase();
  const text = `${title} ${body}`;

  if (labels.some((l) => l.includes('bug') || l.includes('test'))) return 'tester';
  if (labels.some((l) => l.includes('devops') || l.includes('deploy') || l.includes('infra'))) return 'devops';
  if (labels.some((l) => l.includes('feature') || l.includes('api') || l.includes('backend') || l.includes('frontend'))) return 'developer';
  if (labels.some((l) => l.includes('docs') || l.includes('research') || l.includes('analysis'))) return 'analyst';

  // Fallback by keywords in text
  if (/деплой|ci\/cd|docker|kubernetes|infra/i.test(text)) return 'devops';
  if (/баг|bug|тест|test/i.test(text)) return 'tester';
  if (/api|код|python|sql|backend|frontend/i.test(text)) return 'developer';
  if (/анализ|исследован|ТЗ|требовани/i.test(text)) return 'analyst';

  return 'developer'; // default
}

// ─── Generate AI trigger comment ─────────────────────────────────────────────

async function buildAITriggerComment(role, targetStatus, issue) {
  const title = issue.title || '';
  const body = issue.body || '';
  const roleKey = role.toLowerCase();

  // Try LLM first
  const llmText = await generateAITriggerLLM(roleKey, targetStatus, title, body);
  if (llmText) {
    return `🤖 **AI-подсказка для роли \`${role}\` → ${targetStatus}**\n\n${llmText}`;
  }

  // Fallback to static triggers
  const staticTrigger =
    AI_ROLE_TRIGGERS[roleKey]?.[targetStatus.toLowerCase().replace(' ', '_')] ||
    AI_ROLE_TRIGGERS[roleKey]?.in_progress;

  if (staticTrigger) {
    return `🤖 **AI-подсказка для роли \`${role}\` → ${targetStatus}**\n\n${staticTrigger}`;
  }

  return null;
}

// ─── Main move handler ────────────────────────────────────────────────────────

/**
 * Handle a /move command.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {Function} graphqlFn — authenticated graphql function
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @param {object} params.issue
 * @param {string} params.commentBody — the comment containing /move
 * @param {string} params.commenterLogin
 * @param {string} [params.currentStatus]
 */
export async function handleMove(
  octokit,
  graphqlFn,
  { owner, repo, issueNumber, issue, commentBody, commenterLogin, currentStatus },
) {
  try {
    const targetStatus = parseMoveCommand(commentBody);
    if (!targetStatus) {
      await postComment(
        octokit,
        owner,
        repo,
        issueNumber,
        `❌ Не удалось распознать статус в команде \`/move\`. Используйте один из: ${STATUSES.join(', ')}`,
      );
      return;
    }

    console.log(`[move] ${owner}/${repo}#${issueNumber}: "${currentStatus}" → "${targetStatus}" by @${commenterLogin}`);

    // Fetch comments for validation
    const comments = await getIssueComments(octokit, owner, repo, issueNumber);

    // Validate transition
    const from = currentStatus || 'Backlog';
    const validation = validateTransition(from, targetStatus, issue, comments, commenterLogin);

    if (!validation.ok) {
      const failBody = `${MOVE_MARKER}
## ❌ Переход невозможен

**Откуда:** ${from}
**Куда:** ${targetStatus}
**Причина:** ${validation.reason}

Исправьте задачу и повторите команду \`/move ${targetStatus}\`.`;

      await upsertBotComment(octokit, owner, repo, issueNumber, MOVE_MARKER, failBody);
      return;
    }

    // Get project item
    const { itemId } = await getProjectItemForIssue(
      graphqlFn,
      PROJECT_ID,
      owner,
      repo,
      issueNumber,
    );

    let projectUpdated = false;
    if (itemId) {
      // Resolve status option ID
      const optionId = await resolveStatusOptionId(graphqlFn, targetStatus);
      if (optionId) {
        projectUpdated = await updateProjectItemStatus(
          graphqlFn,
          PROJECT_ID,
          itemId,
          STATUS_FIELD_ID,
          optionId,
        );
      } else {
        console.warn(`[move] Could not resolve option ID for status "${targetStatus}"`);
      }
    } else {
      console.warn(`[move] Issue ${issueNumber} not found in project ${PROJECT_ID}`);
    }

    // Build success comment
    const successBody = `${MOVE_MARKER}
## ✅ Статус обновлён

**${from}** → **${targetStatus}**
${projectUpdated ? '✓ GitHub Projects V2 обновлён' : '⚠ Обновление проекта: не удалось найти задачу в проекте'}
*Инициатор: @${commenterLogin} | ${nowMoscow()}*`;

    await upsertBotComment(octokit, owner, repo, issueNumber, MOVE_MARKER, successBody);

    // Post AI trigger comment (non-blocking)
    const role = inferRole(issue);
    const aiComment = await buildAITriggerComment(role, targetStatus, issue);
    if (aiComment) {
      await postComment(octokit, owner, repo, issueNumber, aiComment);
    }

    console.log(`[move] Done. ${from} → ${targetStatus}, projectUpdated=${projectUpdated}`);
  } catch (err) {
    console.error(`[move] handleMove error: ${err.message}`);
    try {
      await postComment(
        octokit,
        owner,
        repo,
        issueNumber,
        `❌ Внутренняя ошибка при обработке команды /move: ${err.message}`,
      );
    } catch {
      // ignore
    }
  }
}
