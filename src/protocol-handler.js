/**
 * protocol-handler.js — Parse meeting protocols and create issues
 *
 * Trigger: label "Протокол" added to an issue.
 * The bot uses AI to extract action items from the protocol text,
 * then creates individual issues in the SAME repository.
 */

import { TEAM_ROUTING, GITHUB_ORG, nowMoscow } from './config.js';
import { callLLM } from './llm-client.js';
import { postComment, addLabels } from './github-client.js';

const PROCESSING_MARKER = '<!-- protocol-processing -->';
const RESULT_MARKER = '<!-- protocol-result -->';

// ─── GitHub login mapping ──────────────────────────────────────────────────

const GITHUB_LOGINS = {
  ИС: 'ivansym95-glitch',
  ДС: 'HardCoreDevMachine',
  // Add more mappings as team members join GitHub:
  // РК: 'roman-kovalev',
  // ДА: 'anisimov-d',
};

/**
 * Resolve a person mentioned in protocol text to a GitHub login.
 * Tries: full name match, initials match, first name match.
 * @param {string} personText — e.g. "Тимур", "Саночкин Дмитрий", "ИС"
 * @returns {string|null} GitHub login or null
 */
function resolveGitHubLogin(personText) {
  if (!personText) return null;
  const text = personText.trim().toLowerCase();

  for (const [id, member] of Object.entries(TEAM_ROUTING)) {
    const nameLower = member.name.toLowerCase();
    const [lastName, firstName] = member.name.split(' ');

    // Exact full name
    if (text === nameLower) return GITHUB_LOGINS[id] || null;

    // Initials match
    if (text === id.toLowerCase()) return GITHUB_LOGINS[id] || null;

    // First name match
    if (firstName && text === firstName.toLowerCase()) return GITHUB_LOGINS[id] || null;

    // Last name match
    if (lastName && text === lastName.toLowerCase()) return GITHUB_LOGINS[id] || null;

    // Partial match (name contains text or text contains name)
    if (nameLower.includes(text) || text.includes(nameLower)) {
      return GITHUB_LOGINS[id] || null;
    }
  }

  return null;
}

/**
 * Resolve person to team member ID + name (even without GitHub login).
 * @param {string} personText
 * @returns {{id: string, name: string, login: string|null}|null}
 */
function resolveTeamMember(personText) {
  if (!personText) return null;
  const text = personText.trim().toLowerCase();

  for (const [id, member] of Object.entries(TEAM_ROUTING)) {
    const nameLower = member.name.toLowerCase();
    const [lastName, firstName] = member.name.split(' ');

    if (
      text === nameLower ||
      text === id.toLowerCase() ||
      (firstName && text === firstName.toLowerCase()) ||
      (lastName && text === lastName.toLowerCase()) ||
      nameLower.includes(text) ||
      text.includes(nameLower)
    ) {
      return { id, name: member.name, login: GITHUB_LOGINS[id] || null };
    }
  }

  return null;
}

// ─── AI parsing ────────────────────────────────────────────────────────────

/**
 * Use AI to extract action items from protocol text.
 * @param {string} title — issue title
 * @param {string} body — protocol text
 * @returns {Promise<Array<{title: string, body: string, assignee_name: string}>>}
 */
async function parseProtocolWithAI(title, body) {
  const teamList = Object.entries(TEAM_ROUTING)
    .map(([id, m]) => `${id}: ${m.name} (${m.keywords.slice(0, 3).join(', ')})`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: `Ты парсер протоколов совещаний. Извлекай конкретные задачи (action items) из текста.
Каждая задача должна иметь:
- title: чёткий SMART-заголовок с глаголом (что сделать)
- body: описание задачи с контекстом из протокола, сроком если указан
- assignee_name: имя ответственного как указано в тексте (имя/фамилия)

НЕ создавай задачи из:
- Общих обсуждений без конкретного действия
- Информационных пунктов ("обсудили", "отметили")
- Пунктов без ответственного

Отвечай ТОЛЬКО валидным JSON-массивом. Без markdown.`,
    },
    {
      role: 'user',
      content: `Протокол: "${title}"

Текст:
${body?.slice(0, 3000) || ''}

Команда:
${teamList}

Верни JSON-массив задач: [{"title": "...", "body": "...", "assignee_name": "..."}]`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 2000, temperature: 0.2 });
  if (!raw) return [];

  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    console.error('[protocol] Failed to parse AI response:', raw?.slice(0, 200));
    return [];
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────

/**
 * Handle a protocol issue — parse and create sub-issues.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo — issues are created in this same repo
 * @param {number} params.issueNumber
 * @param {object} params.issue
 */
export async function handleProtocol(octokit, { owner, repo, issueNumber, issue }) {
  try {
    const title = issue.title || '';
    const body = issue.body || '';

    console.log(`[protocol] Processing protocol: ${owner}/${repo}#${issueNumber}`);

    // Post "processing" comment
    await postComment(
      octokit,
      owner,
      repo,
      issueNumber,
      `${PROCESSING_MARKER}\n## ⏳ Обрабатываю протокол...\n\nАнализирую текст и распределяю задачи. Это займёт 20-30 секунд.`,
    );

    // Parse with AI
    const tasks = await parseProtocolWithAI(title, body);

    if (tasks.length === 0) {
      await postComment(
        octokit,
        owner,
        repo,
        issueNumber,
        `${RESULT_MARKER}\n## ⚠️ Задачи не найдены\n\nНе удалось извлечь конкретные задачи из протокола. Проверьте, что текст содержит action items с указанием ответственных.`,
      );
      return;
    }

    // Create issues
    const created = [];
    const failed = [];

    for (const task of tasks) {
      try {
        const member = resolveTeamMember(task.assignee_name);
        const assigneeLogin = member?.login || null;

        const taskBody = `${task.body || ''}\n\n---\n*Создано из протокола: #${issueNumber}*`;

        const createParams = {
          owner,
          repo,
          title: task.title,
          body: taskBody,
        };

        // Only add assignees if we have a valid GitHub login
        if (assigneeLogin) {
          createParams.assignees = [assigneeLogin];
        }

        const { data: newIssue } = await octokit.rest.issues.create(createParams);

        const assigneeInfo = assigneeLogin
          ? `@${assigneeLogin}`
          : member
            ? `${member.name} (нет GitHub)`
            : `${task.assignee_name} (не определён)`;

        created.push({
          number: newIssue.number,
          title: task.title,
          url: newIssue.html_url,
          assignee: assigneeInfo,
        });

        console.log(`[protocol] Created issue #${newIssue.number}: ${task.title}`);
      } catch (err) {
        failed.push({
          title: task.title,
          assignee: task.assignee_name,
          error: err.message,
        });
        console.error(`[protocol] Failed to create issue "${task.title}": ${err.message}`);
      }
    }

    // Build result comment
    let resultBody = `${RESULT_MARKER}\n## ✅ Протокол обработан — создано ${created.length} задач\n\n`;

    for (const c of created) {
      resultBody += `- [${c.title}](${c.url}) → \`${repo}\` → ${c.assignee}\n`;
    }

    if (failed.length > 0) {
      resultBody += `\n### ❌ Не удалось создать (${failed.length})\n`;
      for (const f of failed) {
        resultBody += `- ${f.title} (${f.assignee}): ${f.error}\n`;
      }
    }

    resultBody += `\n---\n<sub>Обработано: ${nowMoscow()} | Проверьте задачи и при необходимости скорректируйте описание или исполнителя</sub>`;

    await postComment(octokit, owner, repo, issueNumber, resultBody);

    // Add "protocol: processed" label
    await addLabels(octokit, owner, repo, issueNumber, ['protocol: processed']);

    console.log(`[protocol] Done. Created ${created.length}, failed ${failed.length}`);
  } catch (err) {
    console.error(`[protocol] handleProtocol error: ${err.message}`);
    try {
      await postComment(
        octokit,
        owner,
        repo,
        issueNumber,
        `${RESULT_MARKER}\n## ❌ Ошибка обработки протокола\n\n${err.message}`,
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Check if an issue has the protocol label.
 * @param {object} issue
 * @returns {boolean}
 */
export function isProtocolIssue(issue) {
  const labels = (issue.labels || []).map((l) =>
    (typeof l === 'string' ? l : l.name || '').toLowerCase(),
  );
  return labels.some((l) => l === 'протокол' || l === 'protocol');
}

/**
 * Check if a label event is adding the protocol label.
 * @param {object} payload — webhook payload
 * @returns {boolean}
 */
export function isProtocolLabelAdded(payload) {
  if (payload.action !== 'labeled') return false;
  const labelName = (payload.label?.name || '').toLowerCase();
  return labelName === 'протокол' || labelName === 'protocol';
}
