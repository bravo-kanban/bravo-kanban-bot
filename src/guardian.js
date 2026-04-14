/**
 * guardian.js — 9 Kanban Commandments Validator
 *
 * Checks an issue against the 9 commandments and upserts a Guardian comment.
 */

import {
  VAGUE_VERBS_RU,
  VAGUE_DOD_PHRASES,
  VAGUE_REFERENCES,
  AC_MARKERS,
  DEADLINE_MARKERS,
  DOD_MARKERS,
  WIP_LIMIT,
  GUARDIAN_REPOS,
  GITHUB_ORG,
  STATUS_FORWARD_ORDER,
  nowMoscow,
} from './config.js';
import { upsertBotComment } from './github-client.js';
import { countInProgressForAssignee } from './github-client.js';
import {
  checkAtomicityLLM,
  checkSmartLLM,
  checkDoDLLM,
  checkInSystemLLM,
} from './llm-client.js';
import { suggestRouting } from './team-routing.js';

const MARKER = '<!-- guardian-check -->';

// ─── Status normalization ─────────────────────────────────────────────────────

function normalizeStatus(rawStatus) {
  if (!rawStatus) return 'Backlog';
  const s = rawStatus.trim().toLowerCase();
  if (s.includes('backlog')) return 'Backlog';
  if (s.includes('to do') || s.includes('todo')) return 'To Do';
  if (s.includes('in progress') || s.includes('в работе')) return 'In Progress';
  if (s.includes('review') || s.includes('ревью')) return 'Review';
  if (s.includes('done') || s.includes('готово') || s.includes('закрыто')) return 'Done';
  return 'Backlog';
}

function statusIndex(status) {
  return STATUS_FORWARD_ORDER[status] ?? 0;
}

// ─── Check 1: Atomicity ───────────────────────────────────────────────────────

async function checkAtomicity(title, body) {
  // Basic regex checks first
  const andJoin = /\bи\b.{5,50}\bи\b|\band\b.{5,50}\band\b/i;
  const subtaskCount = (body || '').match(/^[-*]\s+/gm)?.length || 0;

  let regexPass = true;
  let regexComment = 'Задача атомарна';

  if (andJoin.test(title)) {
    regexPass = false;
    regexComment = 'Заголовок содержит "и/and" — возможно объединение несвязанных действий';
  } else if (subtaskCount >= 3) {
    regexPass = false;
    regexComment = `Обнаружено ${subtaskCount} независимых подзадач без объединяющей цели`;
  }

  // LLM enhancement
  const llmResult = await checkAtomicityLLM(title, body);
  if (llmResult) {
    return { pass: llmResult.pass, comment: llmResult.comment };
  }

  return { pass: regexPass, comment: regexComment };
}

// ─── Check 2: SMART ───────────────────────────────────────────────────────────

async function checkSmart(title, body) {
  const titleLower = title.toLowerCase();

  // Check for vague verbs
  const vagueVerb = VAGUE_VERBS_RU.find((v) => titleLower.startsWith(v.toLowerCase()));
  if (vagueVerb) {
    return {
      pass: false,
      comment: `Заголовок начинается с размытого глагола "${vagueVerb}"`,
    };
  }

  // Check for verb in title (must have some action word)
  const hasVerb = /[а-яА-ЯёЁa-zA-Z]{3,}/.test(title);
  if (!hasVerb || title.trim().length < 5) {
    return { pass: false, comment: 'Заголовок слишком короткий или не содержит глагол' };
  }

  // Check for AC in body
  const bodyLower = (body || '').toLowerCase();
  const hasAC = AC_MARKERS.some((m) => bodyLower.includes(m.toLowerCase()));
  if (!hasAC) {
    // LLM check
    const llmResult = await checkSmartLLM(title, body);
    if (llmResult) {
      if (!llmResult.pass) return { pass: false, comment: llmResult.comment };
    } else {
      return {
        pass: false,
        comment: 'Отсутствуют критерии приёмки (acceptance criteria / AC)',
      };
    }
  }

  return { pass: true, comment: 'Заголовок содержит глагол+объект, критерии приёмки присутствуют' };
}

// ─── Check 3: Single Owner ────────────────────────────────────────────────────

function checkSingleOwner(issue, status) {
  const assignees = issue.assignees || [];
  const idx = statusIndex(status);

  if (idx === 0) {
    // Backlog — assignee optional
    return { pass: true, comment: 'Backlog: назначение исполнителя необязательно', type: 'na' };
  }

  if (assignees.length === 0) {
    return { pass: false, comment: 'To Do+: не назначен исполнитель' };
  }
  if (assignees.length > 1) {
    return {
      pass: false,
      comment: `Назначено ${assignees.length} исполнителя — допустим только один`,
    };
  }
  return { pass: true, comment: `Исполнитель: @${assignees[0].login}` };
}

// ─── Check 4: Deadline ────────────────────────────────────────────────────────

function checkDeadline(issue, status) {
  const body = issue.body || '';
  const idx = statusIndex(status);

  if (idx === 0) {
    return { pass: true, comment: 'Backlog: дедлайн необязателен', type: 'na' };
  }

  let foundDate = null;
  for (const pattern of DEADLINE_MARKERS) {
    const match = body.match(pattern);
    if (match) {
      foundDate = match[1];
      break;
    }
  }

  if (!foundDate) {
    return { pass: false, comment: 'To Do+: дедлайн не указан в описании' };
  }

  // Check if past due
  try {
    // Try to parse the date
    const parts = foundDate.split(/[./\-\s]/);
    let dateObj = null;

    if (parts.length >= 3) {
      const [a, b, c] = parts;
      // DD.MM.YYYY or YYYY-MM-DD
      if (a.length === 4) {
        dateObj = new Date(`${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`);
      } else {
        dateObj = new Date(`${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`);
      }
    }

    if (dateObj && !isNaN(dateObj.getTime())) {
      const now = new Date();
      if (dateObj < now) {
        return {
          pass: true,
          warn: true,
          comment: `⚠ Дедлайн ${foundDate} уже прошёл`,
        };
      }
    }
  } catch {
    // ignore parse errors
  }

  return { pass: true, comment: `Дедлайн: ${foundDate}` };
}

// ─── Check 5: Status Transparency ────────────────────────────────────────────

function checkStatusTransparency(issue, comments, status) {
  if (status !== 'In Progress') {
    return { pass: true, comment: 'Проверка актуальна только для In Progress', type: 'na' };
  }

  // Find the date when status was last changed or issue updated
  const updatedAt = new Date(issue.updated_at);
  const now = new Date();
  const diffMs = now - updatedAt;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  // Business days approximation (rough: weekdays only)
  const businessDays = Math.floor(diffDays * (5 / 7));

  // Get last comment date
  const lastComment = comments.length > 0 ? new Date(comments[comments.length - 1].created_at) : null;
  const daysSinceComment = lastComment
    ? (now - lastComment) / (1000 * 60 * 60 * 24)
    : diffDays;

  if (daysSinceComment >= 5) {
    return {
      pass: false,
      warn: true,
      type: 'escalation',
      comment: `🔴 ЭСКАЛАЦИЯ: без обновлений ≥5 дней (${Math.floor(daysSinceComment)} дн.)`,
    };
  }
  if (daysSinceComment >= 2) {
    return {
      pass: true,
      warn: true,
      comment: `⚠ В работе без обновлений ≥2 дня (${Math.floor(daysSinceComment)} дн.)`,
    };
  }

  return { pass: true, comment: 'Активность в норме' };
}

// ─── Check 6: WIP Limit ───────────────────────────────────────────────────────

async function checkWipLimit(octokit, issue) {
  const assignees = issue.assignees || [];
  if (assignees.length === 0) {
    return { pass: true, comment: 'Нет исполнителя — WIP не проверяется', type: 'na' };
  }

  const assigneeLogin = assignees[0].login;

  let wipCount = 0;
  try {
    wipCount = await countInProgressForAssignee(octokit, GITHUB_ORG, GUARDIAN_REPOS, assigneeLogin);
  } catch (err) {
    return { pass: true, comment: `Не удалось проверить WIP: ${err.message}`, type: 'warn' };
  }

  if (wipCount >= WIP_LIMIT) {
    return {
      pass: false,
      comment: `@${assigneeLogin} уже имеет ${wipCount} задач In Progress (лимит: ${WIP_LIMIT})`,
    };
  }

  return { pass: true, comment: `WIP @${assigneeLogin}: ${wipCount}/${WIP_LIMIT}` };
}

// ─── Check 7: Definition of Done ─────────────────────────────────────────────

async function checkDoD(body) {
  const bodyLower = (body || '').toLowerCase();

  // Check for DoD section
  const hasSection = DOD_MARKERS.some((m) => bodyLower.includes(m.toLowerCase()));
  if (!hasSection) {
    return {
      pass: false,
      comment: 'Отсутствует раздел "Критерии готовности" / DoD',
    };
  }

  // Check for at least 1 checkbox
  const hasCheckbox = /- \[[ xX]\]/.test(body || '');
  if (!hasCheckbox) {
    return { pass: false, comment: 'DoD не содержит ни одного чекбокса (- [ ])' };
  }

  // Check for vague criteria
  const vagueFound = VAGUE_DOD_PHRASES.find((p) => bodyLower.includes(p.toLowerCase()));
  if (vagueFound) {
    return {
      pass: false,
      comment: `DoD содержит размытый критерий: "${vagueFound}"`,
    };
  }

  // LLM enhancement
  const llmResult = await checkDoDLLM(body);
  if (llmResult && !llmResult.pass) {
    return { pass: false, comment: llmResult.comment };
  }

  return { pass: true, comment: 'DoD присутствует и содержит проверяемые критерии' };
}

// ─── Check 8: Everything in System ───────────────────────────────────────────

async function checkInSystem(body) {
  if (!body || body.trim().length < 30) {
    return { pass: false, comment: 'Описание пустое или слишком короткое (<30 символов)' };
  }

  const bodyLower = body.toLowerCase();

  const vagueRef = VAGUE_REFERENCES.find((r) => bodyLower.includes(r.toLowerCase()));
  if (vagueRef) {
    return {
      pass: false,
      comment: `Описание содержит отсылку к внешнему обсуждению: "${vagueRef}"`,
    };
  }

  // LLM enhancement
  const llmResult = await checkInSystemLLM(body);
  if (llmResult && !llmResult.pass) {
    return { pass: false, comment: llmResult.comment };
  }

  return { pass: true, comment: 'Вся информация содержится в системе' };
}

// ─── Check 9: Backlog Grooming ────────────────────────────────────────────────

function checkBacklogGrooming(issue, status) {
  if (status !== 'Backlog') {
    return { pass: true, comment: 'Проверка актуальна только для Backlog', type: 'na' };
  }

  const updatedAt = new Date(issue.updated_at);
  const now = new Date();
  const diffDays = (now - updatedAt) / (1000 * 60 * 60 * 24);

  if (diffDays > 60) {
    return {
      pass: true,
      warn: true,
      comment: `⚠ Задача в Backlog более 60 дней — рекомендуется архивировать`,
    };
  }
  if (diffDays > 30) {
    return {
      pass: true,
      warn: true,
      comment: `⚠ Задача в Backlog более 30 дней без обновлений`,
    };
  }

  return { pass: true, comment: `Задача обновлена ${Math.floor(diffDays)} дн. назад` };
}

// ─── Result cell formatting ───────────────────────────────────────────────────

function fmtStatus(result) {
  if (result.type === 'na') return '—';
  if (result.type === 'escalation') return '🚨';
  if (!result.pass) return '✗';
  if (result.warn) return '⚠';
  return '✓';
}

// ─── Main Guardian check ──────────────────────────────────────────────────────

/**
 * Run all 9 commandment checks and post/update the Guardian comment.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @param {object} params.issue — full issue object
 * @param {string} [params.projectStatus] — current project status column name
 * @param {Array} params.comments — existing comments
 */
export async function runGuardian(octokit, { owner, repo, issueNumber, issue, projectStatus, comments }) {
  try {
    const status = normalizeStatus(projectStatus || '');
    const title = issue.title || '';
    const body = issue.body || '';

    console.log(`[guardian] Checking ${owner}/${repo}#${issueNumber} (status: ${status})`);

    // Run all checks concurrently where possible
    const [
      c1, c2, c5, c7, c8, c9,
    ] = await Promise.all([
      checkAtomicity(title, body),
      checkSmart(title, body),
      checkStatusTransparency(issue, comments, status),
      checkDoD(body),
      checkInSystem(body),
      Promise.resolve(checkBacklogGrooming(issue, status)),
    ]);

    const c3 = checkSingleOwner(issue, status);
    const c4 = checkDeadline(issue, status);
    const c6 = await checkWipLimit(octokit, issue);

    const results = [c1, c2, c3, c4, c5, c6, c7, c8, c9];

    // Determine overall verdict
    const blockingFails = [c1, c2, c3, c4, c6, c7, c8].filter(
      (r) => r.type !== 'na' && !r.pass,
    );
    const warnings = results.filter((r) => r.pass && r.warn);

    let verdict;
    if (blockingFails.length > 0) {
      verdict = '🚫 BLOCKED';
    } else if (warnings.length > 0) {
      verdict = '⚠️ PASSED WITH WARNINGS';
    } else {
      verdict = '✅ PASSED';
    }

    // Get routing suggestion
    const routing = await suggestRouting(title, body);

    // Build comment
    const names = [
      'Атомарность',
      'SMART',
      'Единый владелец',
      'Дедлайн',
      'Прозрачность статуса',
      'WIP-лимит',
      'Definition of Done',
      'Всё в системе',
      'Бэклог-груминг',
    ];

    const types = [
      '[BLOCK]',
      '[BLOCK]',
      '[BLOCK]',
      '[BLOCK]',
      '[WARN]',
      '[BLOCK]',
      '[BLOCK]',
      '[BLOCK]',
      '[WARN]',
    ];

    let table =
      '| # | Заповедь | Тип | Статус | Комментарий |\n|---|---|---|---|---|\n';
    results.forEach((r, i) => {
      table += `| ${i + 1} | ${names[i]} | ${types[i]} | ${fmtStatus(r)} | ${r.comment} |\n`;
    });

    const assigneeLogin = issue.assignees?.[0]?.login || null;
    const routingBlock = routing
      ? `**Рекомендуемый исполнитель:** **${routing.id}** (${routing.name})\n**Обоснование:** ${routing.reasoning}`
      : `**Рекомендуемый исполнитель:** не удалось определить`;

    const commentBody = `${MARKER}
## 🛡️ Guardian Check

*Статус задачи: **${status}** | Проверено: ${nowMoscow()}*

${table}

**Вердикт: ${verdict}**

---
### 📋 Рекомендация по назначению
${routingBlock}
`;

    await upsertBotComment(octokit, owner, repo, issueNumber, MARKER, commentBody);
    console.log(`[guardian] Done. Verdict: ${verdict}`);
  } catch (err) {
    console.error(`[guardian] runGuardian error: ${err.message}`);
  }
}

/**
 * Check if a comment body triggers Guardian.
 * @param {string} body
 * @returns {boolean}
 */
export function isGuardianTrigger(body) {
  if (!body) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('/guardian') ||
    lower.includes('@guardian') ||
    lower.includes('re-check') ||
    lower.includes('recheck')
  );
}
