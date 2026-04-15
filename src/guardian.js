/**
 * guardian.js — 9 Kanban Commandments Validator
 *
 * Checks an issue against the 9 commandments using per-project Guardian profiles.
 * Each project can enable/disable checks, set them as blocking or warning,
 * and configure its own WIP limit.
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
  GUARDIAN_PROFILES,
  GITHUB_ORG,
  STATUS_FORWARD_ORDER,
  nowMoscow,
} from './config.js';
import {
  postComment,
  updateComment,
  countInProgressForAssignee,
  getStatusFieldOptions,
  updateProjectItemStatus,
} from './github-client.js';
import {
  checkAtomicityLLM,
  checkSmartLLM,
  checkDoDLLM,
  checkInSystemLLM,
} from './llm-client.js';
import { suggestRouting } from './team-routing.js';

const MARKER = '<!-- guardian-check -->';

// ─── Debounce — prevents duplicate runs from overlapping webhook events ──────
//
// Problem: Guardian takes up to 60–90s (LLM checks). When it moves a card to
// Backlog, GitHub fires projects_v2_item.edited, which triggers a second run.
// A simple timestamp-from-start debounce fails because the window expires
// before the first run finishes.
//
// Solution: record timestamp at BOTH start and finish of each run.
// The 30s debounce window resets after the run completes, so any follow-up
// webhook event within 30s of completion is suppressed.

const recentGuardianRuns = new Map(); // key: "owner/repo#number" → timestamp
const DEBOUNCE_MS = 30_000; // 30 seconds after last activity

function shouldDebounce(owner, repo, issueNumber) {
  const key = `${owner}/${repo}#${issueNumber}`;
  const lastRun = recentGuardianRuns.get(key);
  const now = Date.now();
  if (lastRun && now - lastRun < DEBOUNCE_MS) {
    console.log(`[guardian] Debounce: skipping ${key} (ran ${now - lastRun}ms ago)`);
    return true;
  }
  recentGuardianRuns.set(key, now);
  // Cleanup old entries
  if (recentGuardianRuns.size > 100) {
    for (const [k, v] of recentGuardianRuns) {
      if (now - v > 300_000) recentGuardianRuns.delete(k);
    }
  }
  return false;
}

/** Refresh debounce timestamp (call after run completes). */
function refreshDebounce(owner, repo, issueNumber) {
  const key = `${owner}/${repo}#${issueNumber}`;
  recentGuardianRuns.set(key, Date.now());
}

// ─── Default profile (fallback when project has no profile) ──────────────────

const DEFAULT_PROFILE = {
  enabled: true,
  checks: {
    atomicity:          { enabled: true, type: 'block' },
    smart:              { enabled: true, type: 'block' },
    singleOwner:        { enabled: true, type: 'block' },
    deadline:           { enabled: true, type: 'block' },
    statusTransparency: { enabled: true, type: 'warn'  },
    wipLimit:           { enabled: true, type: 'block' },
    dod:                { enabled: true, type: 'block' },
    inSystem:           { enabled: true, type: 'block' },
    backlogGrooming:    { enabled: true, type: 'warn'  },
  },
  wipLimit: WIP_LIMIT,
  autoMoveToBacklog: true,
};

/**
 * Resolve the Guardian profile for a given project key.
 * Falls back to DEFAULT_PROFILE if no profile is configured.
 */
function getProfile(projectKey) {
  if (projectKey && GUARDIAN_PROFILES[projectKey]) {
    return GUARDIAN_PROFILES[projectKey];
  }
  return DEFAULT_PROFILE;
}

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

  const llmResult = await checkAtomicityLLM(title, body);
  if (llmResult) {
    return { pass: llmResult.pass, comment: llmResult.comment };
  }

  return { pass: regexPass, comment: regexComment };
}

// ─── Check 2: SMART ───────────────────────────────────────────────────────────

async function checkSmart(title, body) {
  const titleLower = title.toLowerCase();

  const vagueVerb = VAGUE_VERBS_RU.find((v) => titleLower.startsWith(v.toLowerCase()));
  if (vagueVerb) {
    return {
      pass: false,
      comment: `Заголовок начинается с размытого глагола "${vagueVerb}"`,
    };
  }

  const hasVerb = /[а-яА-ЯёЁa-zA-Z]{3,}/.test(title);
  if (!hasVerb || title.trim().length < 5) {
    return { pass: false, comment: 'Заголовок слишком короткий или не содержит глагол' };
  }

  const bodyLower = (body || '').toLowerCase();
  const hasAC = AC_MARKERS.some((m) => bodyLower.includes(m.toLowerCase()));
  if (!hasAC) {
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

  try {
    const parts = foundDate.split(/[./\-\s]/);
    let dateObj = null;

    if (parts.length >= 3) {
      const [a, b, c] = parts;
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

  const updatedAt = new Date(issue.updated_at);
  const now = new Date();
  const diffMs = now - updatedAt;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

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

async function checkWipLimit(octokit, issue, profileWipLimit) {
  const assignees = issue.assignees || [];
  if (assignees.length === 0) {
    return { pass: true, comment: 'Нет исполнителя — WIP не проверяется', type: 'na' };
  }

  const assigneeLogin = assignees[0].login;
  const limit = profileWipLimit ?? WIP_LIMIT;

  let wipCount = 0;
  try {
    wipCount = await countInProgressForAssignee(octokit, GITHUB_ORG, GUARDIAN_REPOS, assigneeLogin);
  } catch (err) {
    return { pass: true, comment: `Не удалось проверить WIP: ${err.message}`, type: 'warn' };
  }

  if (wipCount >= limit) {
    return {
      pass: false,
      comment: `@${assigneeLogin} уже имеет ${wipCount} задач In Progress (лимит: ${limit})`,
    };
  }

  return { pass: true, comment: `WIP @${assigneeLogin}: ${wipCount}/${limit}` };
}

// ─── Check 7: Definition of Done ─────────────────────────────────────────────

async function checkDoD(body) {
  const bodyLower = (body || '').toLowerCase();

  const hasSection = DOD_MARKERS.some((m) => bodyLower.includes(m.toLowerCase()));
  if (!hasSection) {
    return {
      pass: false,
      comment: 'Отсутствует раздел "Критерии готовности" / DoD',
    };
  }

  const hasCheckbox = /- \[[ xX]\]/.test(body || '');
  if (!hasCheckbox) {
    return { pass: false, comment: 'DoD не содержит ни одного чекбокса (- [ ])' };
  }

  const vagueFound = VAGUE_DOD_PHRASES.find((p) => bodyLower.includes(p.toLowerCase()));
  if (vagueFound) {
    return {
      pass: false,
      comment: `DoD содержит размытый критерий: "${vagueFound}"`,
    };
  }

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
  if (result.type === 'skipped') return '⏭';
  if (!result.pass) return '✗';
  if (result.warn) return '⚠';
  return '✓';
}

// ─── Main Guardian check ──────────────────────────────────────────────────────

/**
 * Run commandment checks using per-project Guardian profile and post a comment.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @param {object} params.issue — full issue object
 * @param {string} [params.projectStatus] — current project status column name
 * @param {Array} params.comments — existing comments
 * @param {Function} [params.graphqlFn] — authenticated graphql function for project mutations
 * @param {object} [params.resolved] — resolved project context
 */
export async function runGuardian(octokit, { owner, repo, issueNumber, issue, projectStatus, comments, graphqlFn, resolved }) {
  try {
    // Global debounce — prevents duplicate comments when multiple webhook events
    // fire for the same issue (e.g. issues.opened + projects_v2_item.edited)
    if (shouldDebounce(owner, repo, issueNumber)) {
      return;
    }

    const projectKey = resolved?.key || null;
    const profile = getProfile(projectKey);

    // If Guardian is disabled for this project, skip entirely
    if (!profile.enabled) {
      console.log(`[guardian] Guardian disabled for project "${projectKey}", skipping`);
      return;
    }

    const status = normalizeStatus(projectStatus || '');
    const title = issue.title || '';
    const body = issue.body || '';

    // Skip Guardian for Backlog tasks — no point checking until they move forward
    if (status === 'Backlog') {
      console.log(`[guardian] Skipping ${owner}/${repo}#${issueNumber} — status is Backlog`);
      return;
    }

    console.log(`[guardian] Checking ${owner}/${repo}#${issueNumber} (project: ${projectKey || 'unknown'}, status: ${status})`);

    // Post "thinking" indicator (always a new comment)
    const thinkingComment = await postComment(
      octokit, owner, repo, issueNumber,
      `${MARKER}\n## 🛡️ Guardian проверяет...  *(${projectKey || 'default'})*\n\nАнализирую задачу. Это может занять до 60 секунд.`,
    );
    const guardianCommentId = thinkingComment?.id;

    // ─── Run checks according to profile ──────────────────────────────────

    const pc = profile.checks;

    // Skipped check placeholder
    const skipped = (name) => ({ pass: true, comment: `Проверка отключена для ${projectKey}`, type: 'skipped' });

    // Run enabled checks concurrently where possible
    const [c1, c2, c5, c7, c8, c9] = await Promise.all([
      pc.atomicity.enabled          ? checkAtomicity(title, body)                  : skipped('atomicity'),
      pc.smart.enabled              ? checkSmart(title, body)                      : skipped('smart'),
      pc.statusTransparency.enabled ? checkStatusTransparency(issue, comments, status) : skipped('statusTransparency'),
      pc.dod.enabled                ? checkDoD(body)                               : skipped('dod'),
      pc.inSystem.enabled           ? checkInSystem(body)                          : skipped('inSystem'),
      pc.backlogGrooming.enabled    ? Promise.resolve(checkBacklogGrooming(issue, status)) : skipped('backlogGrooming'),
    ]);

    const c3 = pc.singleOwner.enabled ? checkSingleOwner(issue, status) : skipped('singleOwner');
    const c4 = pc.deadline.enabled    ? checkDeadline(issue, status)    : skipped('deadline');
    const c6 = pc.wipLimit.enabled    ? await checkWipLimit(octokit, issue, profile.wipLimit) : skipped('wipLimit');

    const results = [c1, c2, c3, c4, c5, c6, c7, c8, c9];

    // ─── Determine blocking vs warning per check ──────────────────────────

    const checkIds = [
      'atomicity', 'smart', 'singleOwner', 'deadline',
      'statusTransparency', 'wipLimit', 'dod', 'inSystem', 'backlogGrooming',
    ];

    // A check is blocking only if: it's enabled, its profile type is 'block', and it failed
    const blockingFails = results.filter((r, i) => {
      if (r.type === 'na' || r.type === 'skipped') return false;
      if (r.pass) return false;
      const checkCfg = pc[checkIds[i]];
      return checkCfg?.enabled && checkCfg?.type === 'block';
    });

    const warnings = results.filter((r, i) => {
      if (r.type === 'na' || r.type === 'skipped') return false;
      // Failed check with type 'warn' counts as warning (not block)
      if (!r.pass && pc[checkIds[i]]?.type === 'warn') return true;
      // Passed check with warn flag
      if (r.pass && r.warn) return true;
      return false;
    });

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

    // ─── Build comment table ──────────────────────────────────────────────

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

    // Dynamic type column based on profile
    const typeLabels = checkIds.map((id) => {
      const cfg = pc[id];
      if (!cfg?.enabled) return '[OFF]';
      return cfg.type === 'block' ? '[BLOCK]' : '[WARN]';
    });

    let table =
      '| # | Заповедь | Тип | Статус | Комментарий |\n|---|---|---|---|---|\n';
    results.forEach((r, i) => {
      table += `| ${i + 1} | ${names[i]} | ${typeLabels[i]} | ${fmtStatus(r)} | ${r.comment} |\n`;
    });

    const assigneeLogin = issue.assignees?.[0]?.login || null;
    const routingBlock = routing
      ? `**Рекомендуемый исполнитель:** **${routing.id}** (${routing.name})\n**Обоснование:** ${routing.reasoning}`
      : `**Рекомендуемый исполнитель:** не удалось определить`;

    const commentBody = `${MARKER}
## 🛡️ Guardian Check — ${projectKey || 'default'}

*Статус задачи: **${status}** | Профиль: **${projectKey || 'default'}** | WIP-лимит: ${profile.wipLimit} | Проверено: ${nowMoscow()}*

${table}

**Вердикт: ${verdict}**

---
### 📋 Рекомендация по назначению
${routingBlock}
`;

    // Update the thinking comment with results
    if (guardianCommentId) {
      await updateComment(octokit, owner, repo, guardianCommentId, commentBody);
    } else {
      await postComment(octokit, owner, repo, issueNumber, commentBody);
    }

    // ─── Auto-move to Backlog if blocked (per profile) ────────────────────

    if (blockingFails.length > 0 && profile.autoMoveToBacklog && status !== 'Backlog' && graphqlFn && resolved) {
      try {
        const pId = resolved.projectId;
        const sfId = resolved.statusFieldId;
        const iId = resolved.itemId;
        if (iId) {
          const options = await getStatusFieldOptions(graphqlFn, pId, sfId);
          const backlogOption = options.find((o) => o.name.toLowerCase().includes('backlog'));
          if (backlogOption) {
            const moved = await updateProjectItemStatus(graphqlFn, pId, iId, sfId, backlogOption.id);
            if (moved) {
              console.log(`[guardian] Moved ${owner}/${repo}#${issueNumber} back to Backlog in ${projectKey}`);
            }
          }
        }
      } catch (moveErr) {
        console.warn(`[guardian] Could not move to Backlog: ${moveErr.message}`);
      }
    }

    // Refresh debounce AFTER run completes so the 30s window starts now,
    // not from when the run started (which could be 60–90s ago).
    refreshDebounce(owner, repo, issueNumber);

    console.log(`[guardian] Done. Project: ${projectKey}, Verdict: ${verdict}`);
  } catch (err) {
    console.error(`[guardian] runGuardian error: ${err.message}`);
    // Still refresh debounce on error to prevent retry storms
    refreshDebounce(owner, repo, issueNumber);
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
