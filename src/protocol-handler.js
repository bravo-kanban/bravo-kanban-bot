/**
 * protocol-handler.js — Parse meeting protocols and create issues
 *
 * Trigger: label "Протокол" added to an issue.
 * The bot uses AI to extract action items from the protocol text,
 * then creates individual issues in the SAME repository.
 */

import { TEAM_ROUTING, GITHUB_ORG, PROJECT_ID, STATUS_FIELD_ID, LINEAR_TEAMS, nowMoscow } from './config.js';
import { callLLM } from './llm-client.js';
import { postComment, addLabels, getProjectItemForIssue, getStatusFieldOptions, updateProjectItemStatus } from './github-client.js';
import {
  linearPostComment, linearCreateIssue, linearAddLabelsToIssue,
  linearFindLabel, linearCreateLabel, linearUpdateIssueState,
} from './linear-client.js';

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
      content: `Ты парсер протоколов совещаний. Твоя задача — извлечь ВСЕ задачи (action items) из текста.

Правила:
1. Если в тексте упоминается действие (что-то нужно сделать) — это задача, извлеки её.
2. Каждая задача:
   - title: заголовок с глаголом ("Поправить текст кнопки", "Помыть окна в офисе")
   - body: описание с контекстом из протокола
   - assignee_name: имя ответственного как указано в тексте. Если не указан — пустая строка "".
3. Извлекай задачи даже если текст выглядит как тест или черновик.
4. НЕ пропускай задачи только из-за неформального стиля.
5. Пропускай ТОЛЬКО чисто информационные фразы без какого-либо действия.

Отвечай СТРОГО валидным JSON-массивом. Никакого markdown, никакого текста до или после JSON.`,
    },
    {
      role: 'user',
      content: `Протокол: "${title}"

Текст:
${body?.slice(0, 3000) || ''}

Команда (для сопоставления имён):
${teamList}

Верни JSON-массив: [{"title": "...", "body": "...", "assignee_name": "..."}]
Если задач нет — верни пустой массив [].`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 2000, temperature: 0.2 });
  console.log('[protocol] AI raw response:', raw?.slice(0, 500) || '<null>');

  if (!raw) {
    console.error('[protocol] AI returned null — API call failed or empty response');
    return [];
  }

  try {
    // Strip markdown fences, leading/trailing text
    let cleaned = raw.replace(/```json\s*|```/g, '').trim();

    // If AI wrapped in an object like {"tasks": [...]}, extract the array
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      // Look for any array property (tasks, items, result, etc.)
      const arrayProp = Object.values(parsed).find((v) => Array.isArray(v));
      if (arrayProp) {
        console.log(`[protocol] Extracted array from object wrapper (${arrayProp.length} items)`);
        return arrayProp;
      }
    }
    console.error('[protocol] Parsed value is not array or object with array:', typeof parsed);
    return [];
  } catch (e) {
    // Try to extract JSON array from surrounding text
    const arrayMatch = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrayMatch) {
      try {
        const extracted = JSON.parse(arrayMatch[0]);
        if (Array.isArray(extracted)) {
          console.log(`[protocol] Extracted JSON array from text (${extracted.length} items)`);
          return extracted;
        }
      } catch { /* fallthrough */ }
    }
    console.error('[protocol] Failed to parse AI response:', e.message, '| raw:', raw?.slice(0, 300));
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
export async function handleProtocol(octokit, { owner, repo, issueNumber, issue, graphqlFn }) {
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
      `${PROCESSING_MARKER}\n## ⏳ Обрабатываю протокол...\n\nАнализирую текст и распределяю задачи. Это может занять до 60 секунд.`,
    );

    // Parse with AI
    const tasks = await parseProtocolWithAI(title, body);

    if (tasks.length === 0) {
      await postComment(
        octokit,
        owner,
        repo,
        issueNumber,
        `${RESULT_MARKER}\n## ⚠️ Задачи не найдены\n\nНе удалось извлечь задачи. Возможные причины:\n- AI не ответил (таймаут awstore)\n- Текст не содержит action items\n\nПопробуйте снять и заново добавить label "Протокол". См. логи PM2 для деталей.`,
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

    // Close the protocol issue and move to Done
    try {
      await octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
      console.log(`[protocol] Closed protocol issue #${issueNumber}`);
    } catch (closeErr) {
      console.warn(`[protocol] Could not close issue: ${closeErr.message}`);
    }

    if (graphqlFn) {
      try {
        const { itemId } = await getProjectItemForIssue(graphqlFn, PROJECT_ID, owner, repo, issueNumber);
        if (itemId) {
          const options = await getStatusFieldOptions(graphqlFn, PROJECT_ID, STATUS_FIELD_ID);
          const doneOption = options.find((o) => o.name.toLowerCase().includes('done'));
          if (doneOption) {
            await updateProjectItemStatus(graphqlFn, PROJECT_ID, itemId, STATUS_FIELD_ID, doneOption.id);
            console.log(`[protocol] Moved #${issueNumber} to Done`);
          }
        }
      } catch (moveErr) {
        console.warn(`[protocol] Could not move to Done: ${moveErr.message}`);
      }
    }

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

// ─── Linear protocol handler ───────────────────────────────────────────

/**
 * Check if a Linear issue has the "Протокол" label.
 */
export function isLinearProtocolIssue(issueData) {
  const labels = issueData?.labels?.nodes || issueData?.labels || [];
  return labels.some((l) => {
    const name = (l.name || '').toLowerCase();
    return name === 'протокол' || name === 'protocol';
  });
}

/**
 * Check if a Linear issue has been processed already (has "protocol: processed" label).
 */
function isLinearProtocolProcessed(issueData) {
  const labels = issueData?.labels?.nodes || issueData?.labels || [];
  return labels.some((l) => (l.name || '').toLowerCase() === 'protocol: processed');
}

/**
 * Handle a Linear protocol issue — parse and create sub-issues.
 *
 * @param {object} params
 * @param {string} params.issueId — Linear issue UUID
 * @param {object} params.issue — { title, body, ... }
 * @param {string} params.teamId — Linear team UUID
 * @param {string} [params.projectId] — Linear project UUID
 */
export async function handleLinearProtocol({ issueId, issue, teamId, projectId }) {
  try {
    const title = issue.title || '';
    const body = issue.body || '';

    console.log(`[protocol-linear] Processing protocol: ${title} (${issueId})`);

    // Post "processing" comment
    await linearPostComment(
      issueId,
      `${PROCESSING_MARKER}\n## \u23F3 \u041E\u0431\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u044E \u043F\u0440\u043E\u0442\u043E\u043A\u043E\u043B...\n\n\u0410\u043D\u0430\u043B\u0438\u0437\u0438\u0440\u0443\u044E \u0442\u0435\u043A\u0441\u0442 \u0438 \u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u044E \u0437\u0430\u0434\u0430\u0447\u0438. \u042D\u0442\u043E \u043C\u043E\u0436\u0435\u0442 \u0437\u0430\u043D\u044F\u0442\u044C \u0434\u043E 60 \u0441\u0435\u043A\u0443\u043D\u0434.`,
    );

    // Parse with AI (reuse the same function)
    const tasks = await parseProtocolWithAI(title, body);

    if (tasks.length === 0) {
      await linearPostComment(
        issueId,
        `${RESULT_MARKER}\n## \u26A0\uFE0F \u0417\u0430\u0434\u0430\u0447\u0438 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u044B\n\n\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0438\u0437\u0432\u043B\u0435\u0447\u044C \u0437\u0430\u0434\u0430\u0447\u0438. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0441\u043D\u044F\u0442\u044C \u0438 \u0437\u0430\u043D\u043E\u0432\u043E \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C label "\u041F\u0440\u043E\u0442\u043E\u043A\u043E\u043B".`,
      );
      return;
    }

    // Create sub-issues in Linear
    const created = [];
    const failed = [];

    for (const task of tasks) {
      try {
        const taskDescription = `${task.body || ''}\n\n---\n*\u0421\u043E\u0437\u0434\u0430\u043D\u043E \u0438\u0437 \u043F\u0440\u043E\u0442\u043E\u043A\u043E\u043B\u0430*`;

        const newIssue = await linearCreateIssue({
          teamId,
          title: task.title,
          description: taskDescription,
          projectId: projectId || undefined,
          parentId: issueId,
        });

        if (newIssue) {
          created.push({
            identifier: newIssue.identifier,
            title: task.title,
            url: newIssue.url,
            assignee: task.assignee_name || '\u043D\u0435 \u043D\u0430\u0437\u043D\u0430\u0447\u0435\u043D',
          });
        } else {
          failed.push({ title: task.title, error: 'API returned null' });
        }
      } catch (err) {
        failed.push({ title: task.title, error: err.message });
        console.error(`[protocol-linear] Failed to create "${task.title}": ${err.message}`);
      }
    }

    // Build result comment
    let resultBody = `${RESULT_MARKER}\n## \u2705 \u041F\u0440\u043E\u0442\u043E\u043A\u043E\u043B \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D \u2014 \u0441\u043E\u0437\u0434\u0430\u043D\u043E ${created.length} \u0437\u0430\u0434\u0430\u0447\n\n`;

    for (const c of created) {
      resultBody += `- [${c.identifier}: ${c.title}](${c.url}) \u2192 ${c.assignee}\n`;
    }

    if (failed.length > 0) {
      resultBody += `\n### \u274C \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0437\u0434\u0430\u0442\u044C (${failed.length})\n`;
      for (const f of failed) {
        resultBody += `- ${f.title}: ${f.error}\n`;
      }
    }

    resultBody += `\n---\n*\u041E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u043E: ${nowMoscow()}*`;

    await linearPostComment(issueId, resultBody);

    // Add "protocol: processed" label
    let processedLabel = await linearFindLabel('protocol: processed', teamId);
    if (!processedLabel) {
      processedLabel = await linearCreateLabel('protocol: processed', teamId, '#27ae60');
    }
    if (processedLabel) {
      await linearAddLabelsToIssue(issueId, [processedLabel.id]);
    }

    // Move protocol issue to Done
    const teamKey = Object.keys(LINEAR_TEAMS).find((k) => LINEAR_TEAMS[k].id === teamId);
    const teamData = teamKey ? LINEAR_TEAMS[teamKey] : null;
    const doneState = teamData?.states?.Done;
    if (doneState) {
      await linearUpdateIssueState(issueId, doneState.id);
      console.log(`[protocol-linear] Moved protocol to Done`);
    }

    console.log(`[protocol-linear] Done. Created ${created.length}, failed ${failed.length}`);
  } catch (err) {
    console.error(`[protocol-linear] Error: ${err.message}`);
    try {
      await linearPostComment(
        issueId,
        `${RESULT_MARKER}\n## \u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0440\u043E\u0442\u043E\u043A\u043E\u043B\u0430\n\n${err.message}`,
      );
    } catch { /* ignore */ }
  }
}
