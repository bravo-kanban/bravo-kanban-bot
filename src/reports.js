/**
 * reports.js — Report constructor for /report command
 *
 * Usage:  /report [отдел:СУР|ФД|Head|все] [статус:...] [сотрудник:login] [тип:Run|Change|Disrupt] [за:7д|14д|30д|спринт] [дедлайн:просрочен|эта_неделя|этот_месяц]
 */

import {
  PROJECTS,
  REPO_ACCESS,
  ORG_OWNER,
  DEADLINE_MARKERS,
  nowMoscow,
} from './config.js';
import { postComment, updateComment } from './github-client.js';

// ─── Command detection ───────────────────────────────────────────────────────

export function isReportCommand(body) {
  if (!body) return false;
  return body.trim().toLowerCase().startsWith('/report');
}

// ─── Parse parameters ────────────────────────────────────────────────────────

const PARAM_PATTERNS = {
  отдел: /(?:отдел|dept):(\S+)/i,
  подпроект: /(?:подпроект|subproject|project):(\S+)/i,
  статус: /(?:статус|status):(\S+)/i,
  сотрудник: /(?:сотрудник|user):@?(\S+)/i,
  тип: /(?:тип|type):(\S+)/i,
  за: /(?:за|period):(\S+)/i,
  дедлайн: /(?:дедлайн|deadline):(\S+)/i,
};

const STATUS_ALIASES = {
  backlog: 'Backlog',
  бэклог: 'Backlog',
  todo: 'To Do',
  to_do: 'To Do',
  in_progress: 'In Progress',
  inprogress: 'In Progress',
  review: 'Review',
  ревью: 'Review',
  done: 'Done',
  готово: 'Done',
};

const PERIOD_MAP = {
  '7д': 7,
  '7d': 7,
  '14д': 14,
  '14d': 14,
  '30д': 30,
  '30d': 30,
  неделя: 7,
  месяц: 30,
  спринт: 14,
};

export function parseReportParams(body) {
  const params = {};
  for (const [key, pattern] of Object.entries(PARAM_PATTERNS)) {
    const match = body.match(pattern);
    if (match) params[key] = match[1];
  }
  return params;
}

// ─── Access control ──────────────────────────────────────────────────────────

/**
 * Determine which project keys the caller can see.
 * @param {string} repo — repo where /report was called
 * @param {string} callerLogin
 * @param {string|undefined} requestedDept — value of отдел: param
 * @returns {string[]} project keys
 */
function getAccessibleProjects(repo, callerLogin, requestedDept) {
  const allowedKeys = REPO_ACCESS[repo] || [];

  // "все" / "all" — cross-project report
  if (requestedDept && (requestedDept === 'все' || requestedDept === 'all')) {
    // Only owner or from org-general (which is owner-restricted)
    if (callerLogin === ORG_OWNER || repo === 'org-general') {
      return Object.keys(PROJECTS);
    }
    return allowedKeys; // non-owner gets only what their repo allows
  }

  // Specific department requested
  if (requestedDept) {
    const deptKey = Object.keys(PROJECTS).find(
      (k) => k.toLowerCase() === requestedDept.toLowerCase(),
    );
    if (deptKey && (allowedKeys.includes(deptKey) || callerLogin === ORG_OWNER)) {
      return [deptKey];
    }
    return []; // no access
  }

  // Default: for sur-tasks, show only sub-projects (not parent СУР)
  if (repo === 'sur-tasks') return ['Браво', 'Клара', 'Инсайд'];
  if (repo === 'org-general') return ['Head'];
  return allowedKeys;
}

// ─── Fetch project items via GraphQL ─────────────────────────────────────────

const ITEMS_QUERY = `
  query($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2Field { name } }
                }
              }
            }
            content {
              ... on Issue {
                number
                title
                body
                state
                updatedAt
                createdAt
                closedAt
                labels(first: 10) { nodes { name } }
                assignees(first: 5) { nodes { login } }
                repository { name owner { login } }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchProjectItems(graphqlFn, projectId) {
  const items = [];
  let cursor = null;

  do {
    const result = await graphqlFn(ITEMS_QUERY, { projectId, cursor });
    const projectNode = result?.node;
    const pageInfo = projectNode?.items?.pageInfo;
    const nodes = projectNode?.items?.nodes || [];

    for (const item of nodes) {
      if (!item.content) continue; // skip draft issues

      const fieldValues = item.fieldValues?.nodes || [];
      const statusField = fieldValues.find(
        (fv) => fv?.field?.name?.toLowerCase() === 'status',
      );
      const typeField = fieldValues.find(
        (fv) => fv?.field?.name === 'Тип деятельности',
      );
      const subprojectField = fieldValues.find(
        (fv) => fv?.field?.name === 'Подпроект',
      );

      items.push({
        number: item.content.number,
        title: item.content.title,
        body: item.content.body || '',
        state: item.content.state,
        updatedAt: item.content.updatedAt,
        createdAt: item.content.createdAt,
        closedAt: item.content.closedAt,
        repo: item.content.repository?.name,
        owner: item.content.repository?.owner?.login,
        labels: (item.content.labels?.nodes || []).map((l) => l.name),
        assignees: (item.content.assignees?.nodes || []).map((a) => a.login),
        status: statusField?.name || 'No Status',
        activityType: typeField?.name || '—',
        subproject: subprojectField?.name || '—',
      });
    }

    cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);

  return items;
}

// ─── Deadline helpers ────────────────────────────────────────────────────────

function extractDeadline(body) {
  if (!body) return null;
  for (const pattern of DEADLINE_MARKERS) {
    const m = body.match(pattern);
    if (m) return m[1];
  }
  return null;
}

function parseDate(str) {
  if (!str) return null;
  const parts = str.split(/[./\-\s]/);
  if (parts.length >= 3) {
    const [a, b, c] = parts;
    if (a.length === 4)
      return new Date(`${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`);
    return new Date(`${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`);
  }
  return null;
}

// ─── Filter items ────────────────────────────────────────────────────────────

function filterItems(items, params) {
  let filtered = [...items];

  // By status
  if (params.статус) {
    const target =
      STATUS_ALIASES[params.статус.toLowerCase()] || params.статус;
    filtered = filtered.filter(
      (i) => i.status.toLowerCase() === target.toLowerCase(),
    );
  }

  // By assignee
  if (params.сотрудник) {
    const login = params.сотрудник.replace('@', '');
    filtered = filtered.filter((i) =>
      i.assignees.some((a) => a.toLowerCase() === login.toLowerCase()),
    );
  }

  // By sub-project (Браво / Клара / Инсайд)
  if (params.подпроект) {
    const target = params.подпроект.toLowerCase();
    filtered = filtered.filter(
      (i) => i.subproject.toLowerCase() === target,
    );
  }

  // By activity type (Run / Change / Disrupt)
  if (params.тип) {
    const target = params.тип.toLowerCase();
    filtered = filtered.filter(
      (i) => i.activityType.toLowerCase() === target,
    );
  }

  // By period (updated within last N days)
  if (params.за) {
    const days =
      PERIOD_MAP[params.за.toLowerCase()] || parseInt(params.за, 10);
    if (days && !isNaN(days)) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      filtered = filtered.filter((i) => new Date(i.updatedAt) >= cutoff);
    }
  }

  // By deadline
  if (params.дедлайн) {
    const dl = params.дедлайн.toLowerCase();
    const now = new Date();

    if (dl === 'просрочен' || dl === 'overdue') {
      filtered = filtered.filter((i) => {
        const d = parseDate(extractDeadline(i.body));
        return d && d < now && i.status !== 'Done';
      });
    } else if (dl === 'эта_неделя' || dl === 'this_week') {
      const endOfWeek = new Date(now);
      endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
      filtered = filtered.filter((i) => {
        const d = parseDate(extractDeadline(i.body));
        return d && d >= now && d <= endOfWeek;
      });
    } else if (dl === 'этот_месяц' || dl === 'this_month') {
      const endOfMonth = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
      );
      filtered = filtered.filter((i) => {
        const d = parseDate(extractDeadline(i.body));
        return d && d >= now && d <= endOfMonth;
      });
    }
  }

  return filtered;
}

// ─── Format report ───────────────────────────────────────────────────────────

function formatReport(items, params, projectKeys) {
  const deptLabel =
    projectKeys.length > 1 ? projectKeys.join(' + ') : projectKeys[0];

  // Build filter description line
  const filterParts = [];
  if (params.подпроект) filterParts.push(`подпроект: ${params.подпроект}`);
  if (params.статус) filterParts.push(`статус: ${params.статус}`);
  if (params.сотрудник) filterParts.push(`сотрудник: @${params.сотрудник}`);
  if (params.тип) filterParts.push(`тип: ${params.тип}`);
  if (params.за) filterParts.push(`период: ${params.за}`);
  if (params.дедлайн) filterParts.push(`дедлайн: ${params.дедлайн}`);
  const filterLine =
    filterParts.length > 0
      ? ` | Фильтры: ${filterParts.join(', ')}`
      : '';

  // Empty result
  if (items.length === 0) {
    return `## 📊 Отчёт: ${deptLabel}\n\n*${nowMoscow()}${filterLine}*\n\nЗадачи не найдены по заданным критериям.`;
  }

  // ── Summary stats ──────────────────────────────────────────────────────────
  const byStatus = {};
  const byType = {};
  const byAssignee = {};

  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    byType[item.activityType] = (byType[item.activityType] || 0) + 1;
    if (item.assignees.length > 0) {
      for (const a of item.assignees) {
        byAssignee[a] = (byAssignee[a] || 0) + 1;
      }
    } else {
      byAssignee['(не назначен)'] = (byAssignee['(не назначен)'] || 0) + 1;
    }
  }

  let summary = `### Сводка\n\n`;
  summary += `**Всего задач:** ${items.length}\n\n`;

  // Status breakdown (ordered)
  summary += `**По статусам:** `;
  const statusOrder = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'];
  const statusParts = [];
  for (const s of statusOrder) {
    if (byStatus[s]) statusParts.push(`${s}: ${byStatus[s]}`);
  }
  for (const [s, count] of Object.entries(byStatus)) {
    if (!statusOrder.includes(s)) statusParts.push(`${s}: ${count}`);
  }
  summary += statusParts.join(' · ') + '\n\n';

  // Type breakdown
  const typeParts = Object.entries(byType).map(([t, c]) => `${t}: ${c}`);
  summary += `**По типу деятельности:** ${typeParts.join(' · ')}\n\n`;

  // Assignee breakdown
  const assigneeParts = Object.entries(byAssignee).map(
    ([a, c]) => `${a}: ${c}`,
  );
  summary += `**По исполнителям:** ${assigneeParts.join(' · ')}\n\n`;

  // ── Detailed table ─────────────────────────────────────────────────────────
  const showItems = items.slice(0, 30);
  const hasMultiDept = projectKeys.length > 1;

  let table = `### Детализация`;
  if (items.length > 30) table += ` (первые 30 из ${items.length})`;
  table += '\n\n';

  if (hasMultiDept) {
    table += `| # | Отдел | Задача | Статус | Тип | Исполнитель | Дедлайн |\n|---|---|---|---|---|---|---|\n`;
    for (const item of showItems) {
      const dept =
        Object.entries(PROJECTS).find(([, v]) =>
          v.repos.includes(item.repo),
        )?.[0] || '—';
      const deadline = extractDeadline(item.body) || '—';
      const assignee =
        item.assignees.length > 0
          ? item.assignees.map((a) => `@${a}`).join(', ')
          : '—';
      const titleShort =
        item.title.length > 45
          ? item.title.slice(0, 45) + '…'
          : item.title;
      table += `| ${item.number} | ${dept} | ${titleShort} | ${item.status} | ${item.activityType} | ${assignee} | ${deadline} |\n`;
    }
  } else {
    table += `| # | Задача | Подпроект | Статус | Тип | Исполнитель | Дедлайн |\n|---|---|---|---|---|---|---|\n`;
    for (const item of showItems) {
      const deadline = extractDeadline(item.body) || '—';
      const assignee =
        item.assignees.length > 0
          ? item.assignees.map((a) => `@${a}`).join(', ')
          : '—';
      const titleShort =
        item.title.length > 45
          ? item.title.slice(0, 45) + '…'
          : item.title;
      table += `| ${item.number} | ${titleShort} | ${item.subproject} | ${item.status} | ${item.activityType} | ${assignee} | ${deadline} |\n`;
    }
  }

  // ── Overdue alerts ─────────────────────────────────────────────────────────
  const now = new Date();
  const overdueItems = items.filter((i) => {
    const d = parseDate(extractDeadline(i.body));
    return d && d < now && i.status !== 'Done';
  });

  let alerts = '';
  if (overdueItems.length > 0) {
    alerts = `\n### ⚠️ Просроченные задачи (${overdueItems.length})\n\n`;
    for (const item of overdueItems.slice(0, 10)) {
      const deadline = extractDeadline(item.body);
      const titleShort =
        item.title.length > 45
          ? item.title.slice(0, 45) + '…'
          : item.title;
      alerts += `- #${item.number} ${titleShort} — дедлайн: ${deadline}\n`;
    }
  }

  return `## 📊 Отчёт: ${deptLabel}\n\n*${nowMoscow()}${filterLine}*\n\n${summary}${table}${alerts}`;
}

// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * Handle /report command.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {Function} graphqlFn
 * @param {object} params
 */
export async function handleReport(
  octokit,
  graphqlFn,
  { owner, repo, issueNumber, commentBody, callerLogin },
) {
  const params = parseReportParams(commentBody);
  const projectKeys = getAccessibleProjects(repo, callerLogin, params.отдел);

  if (projectKeys.length === 0) {
    await postComment(
      octokit,
      owner,
      repo,
      issueNumber,
      `⚠️ У вас нет доступа к запрашиваемому отделу.`,
    );
    return;
  }

  // Post "thinking" indicator
  const thinkingComment = await postComment(
    octokit,
    owner,
    repo,
    issueNumber,
    `📊 Формирую отчёт... Это может занять несколько секунд.`,
  );
  const commentId = thinkingComment?.id;

  try {
    // Fetch items from all accessible projects
    let allItems = [];
    for (const key of projectKeys) {
      const project = PROJECTS[key];
      if (!project) continue;
      const items = await fetchProjectItems(graphqlFn, project.id);
      allItems = allItems.concat(items);
    }

    // Apply filters
    const filtered = filterItems(allItems, params);

    // Format and post report
    const reportBody = formatReport(filtered, params, projectKeys);

    if (commentId) {
      await updateComment(octokit, owner, repo, commentId, reportBody);
    } else {
      await postComment(octokit, owner, repo, issueNumber, reportBody);
    }

    console.log(
      `[report] Done: ${filtered.length} items across ${projectKeys.join(', ')} for @${callerLogin}`,
    );
  } catch (err) {
    console.error(`[report] Error: ${err.message}`, err.stack);
    const errorMsg = `❌ Ошибка при формировании отчёта: ${err.message}`;
    if (commentId) {
      await updateComment(octokit, owner, repo, commentId, errorMsg);
    } else {
      await postComment(octokit, owner, repo, issueNumber, errorMsg);
    }
  }
}
