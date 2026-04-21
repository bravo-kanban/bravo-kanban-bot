/**
 * reviewer.js — Reviewer-агент для задач в статусе "Review" / "На проверке".
 *
 * Триггерится из webhook-обработчика, когда задача переходит в Review.
 * Читает описание, DoD, все комментарии и с помощью LLM решает:
 *   - approve            → (при autoApprove) двигает в Done
 *   - changes_requested  → (при autoReject) возвращает в In Progress + пишет что доделать
 *
 * Поведение настраивается в GUARDIAN_PROFILES[projectKey].reviewer:
 *   { enabled, autoApprove, autoReject, requireLinkedPR }
 */

import { GUARDIAN_PROFILES, nowMoscow } from './config.js';
import { reviewIssueLLM } from './llm-client.js';

const MARKER = '<!-- reviewer -->';

// Simple debounce — предотвращает повторные запуски для одной и той же задачи
// в пределах короткого окна (например, если webhook продублировался).
const REVIEW_DEBOUNCE_MS = 60_000;
const recentReviews = new Map();

function shouldSkipDebounced(issueKey) {
  const now = Date.now();
  const last = recentReviews.get(issueKey);
  if (last && now - last < REVIEW_DEBOUNCE_MS) return true;
  recentReviews.set(issueKey, now);
  // Простая очистка: удаляем старые записи
  if (recentReviews.size > 200) {
    for (const [k, t] of recentReviews) {
      if (now - t > REVIEW_DEBOUNCE_MS * 5) recentReviews.delete(k);
    }
  }
  return false;
}

// ─── Извлечение ссылок на PR из описания и комментариев ───────────────────────

const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi;
const PR_REF_RE = /#\d+/g; // более слабый сигнал; используется только для флага

/**
 * Возвращает строку со всеми найденными ссылками на PR.
 */
function extractLinkedPRs(body, comments) {
  const text = [body || '', ...(comments || []).map((c) => c.body || '')].join('\n');
  const urls = text.match(PR_URL_RE) || [];
  const unique = [...new Set(urls)];
  return unique.join(', ');
}

// ─── Форматирование отчёта ────────────────────────────────────────────────────

function renderDodTable(dodItems) {
  if (!dodItems?.length) return '_DoD не обнаружен в описании._\n';
  let table = '| # | Критерий | Статус | Подтверждение |\n|---|---|---|---|\n';
  dodItems.forEach((item, i) => {
    const mark = item.done ? '✅' : '❌';
    const evidence = (item.evidence || '—').replace(/\|/g, '\\|').slice(0, 200);
    const crit = (item.criterion || '').replace(/\|/g, '\\|').slice(0, 200);
    table += `| ${i + 1} | ${crit} | ${mark} | ${evidence} |\n`;
  });
  return table;
}

function renderMissing(missing) {
  if (!missing?.length) return '';
  return `\n### ❌ Что нужно доделать\n${missing.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n`;
}

// ─── Главная функция ──────────────────────────────────────────────────────────

/**
 * Запускает Reviewer-агента.
 *
 * @param {object} params
 * @param {object} params.issue — { title, body, ... }
 * @param {string} params.issueKey — уникальный ключ (для логов/дебаунса)
 * @param {Array} params.comments — комментарии задачи
 * @param {string} params.projectKey — ключ профиля в GUARDIAN_PROFILES
 * @param {object} params.platform — platform adapter (postComment, moveToState, ...)
 * @returns {Promise<{verdict: string, action: string}|null>}
 */
export async function runReviewer({ issue, issueKey, comments, projectKey, platform }) {
  try {
    const profile = GUARDIAN_PROFILES[projectKey] || GUARDIAN_PROFILES['СУР'];
    const cfg = profile?.reviewer;

    if (!cfg?.enabled) {
      console.log(`[reviewer] Disabled for profile '${projectKey}' — skip`);
      return null;
    }

    if (shouldSkipDebounced(issueKey)) {
      console.log(`[reviewer] Debounced ${issueKey} — recent review within ${REVIEW_DEBOUNCE_MS}ms`);
      return null;
    }

    const title = issue.title || '';
    const body = issue.body || '';

    console.log(`[reviewer] Start ${issueKey} (profile: ${projectKey})`);

    // 1. Thinking-комментарий
    const thinking = await platform.postComment(
      `${MARKER}\n## 🔍 Reviewer думает...\n\nПроверяю выполнение DoD и анализирую комментарии. Это может занять до 60 секунд.`,
    );
    const thinkingId = thinking?.id || null;

    // 2. Требование PR для профилей с requireLinkedPR
    const linkedPRs = extractLinkedPRs(body, comments);
    if (cfg.requireLinkedPR && !linkedPRs) {
      const pinnedBody = `${MARKER}
## 🔍 Reviewer — ${projectKey}

*Проверено: ${nowMoscow()}*

**Вердикт: ❌ CHANGES REQUESTED**

### Причина
К задаче не прикреплён Pull Request. Профиль \`${projectKey}\` требует связанного PR для перехода в Review.

### Что сделать
1. Добавь ссылку на PR (формат: \`https://github.com/.../pull/123\`) в описание или комментарий.
2. После этого переведи задачу в Review заново.
`;
      if (thinkingId) await platform.updateComment(thinkingId, pinnedBody);
      else await platform.postComment(pinnedBody);

      if (cfg.autoReject && typeof platform.moveToState === 'function') {
        await platform.moveToState('In Progress');
        console.log(`[reviewer] ${issueKey} — missing PR, moved back to In Progress`);
      }
      return { verdict: 'changes_requested', action: 'missing_pr' };
    }

    // 3. Вызываем LLM
    const review = await reviewIssueLLM({
      title, body, comments, linkedPRs, projectKey,
    });

    if (!review) {
      const errBody = `${MARKER}
## 🔍 Reviewer — ${projectKey}

*Проверено: ${nowMoscow()}*

⚠️ **Не удалось получить ответ от AI.** Попробуй позже или переведи задачу вручную.`;
      if (thinkingId) await platform.updateComment(thinkingId, errBody);
      else await platform.postComment(errBody);
      return null;
    }

    // 4. Строим финальный отчёт
    const verdictBadge =
      review.verdict === 'approve' ? '✅ APPROVED' : '❌ CHANGES REQUESTED';
    const confidencePct =
      typeof review.confidence === 'number' ? `${Math.round(review.confidence * 100)}%` : '—';

    const prBlock = linkedPRs
      ? `**Связанные PR:** ${linkedPRs}\n\n`
      : '';

    let actionBlock = '';
    let actionTaken = 'none';

    if (review.verdict === 'approve') {
      if (cfg.autoApprove && typeof platform.moveToState === 'function') {
        const moved = await platform.moveToState('Done');
        if (moved) {
          actionBlock = `\n> ✅ **Автодействие:** задача переведена в **Done**.\n`;
          actionTaken = 'moved_to_done';
        } else {
          actionBlock = `\n> ⚠️ Не удалось автоматически перевести в Done — сделай вручную.\n`;
        }
      } else {
        actionBlock = `\n> 👤 Reviewer одобрил. Профиль \`${projectKey}\` требует ручного перевода в Done.\n`;
        actionTaken = 'manual_approval_needed';
      }
    } else {
      if (cfg.autoReject && typeof platform.moveToState === 'function') {
        const moved = await platform.moveToState('In Progress');
        if (moved) {
          actionBlock = `\n> 🔙 **Автодействие:** задача возвращена в **In Progress** для доработки.\n`;
          actionTaken = 'moved_to_in_progress';
        } else {
          actionBlock = `\n> ⚠️ Не удалось автоматически вернуть в In Progress — сделай вручную.\n`;
        }
      } else {
        actionBlock = `\n> 👤 Reviewer запросил доработку. Автоперевод отключён — верни задачу в In Progress вручную.\n`;
        actionTaken = 'manual_rejection_needed';
      }
    }

    const finalBody = `${MARKER}
## 🔍 Reviewer — ${projectKey}

*Проверено: ${nowMoscow()} · Уверенность: ${confidencePct}*

${prBlock}**Вердикт: ${verdictBadge}**
${actionBlock}
### 📋 Проверка по пунктам DoD
${renderDodTable(review.dodItems)}
${renderMissing(review.missing)}
### 💬 Обоснование
${review.reasoning || '—'}
`;

    if (thinkingId) await platform.updateComment(thinkingId, finalBody);
    else await platform.postComment(finalBody);

    console.log(`[reviewer] Done ${issueKey}: verdict=${review.verdict}, action=${actionTaken}`);
    return { verdict: review.verdict, action: actionTaken };
  } catch (err) {
    console.error(`[reviewer] Error on ${issueKey}: ${err.message}`, err.stack);
    return null;
  }
}

// ─── Helpers для webhook'а ────────────────────────────────────────────────────

/**
 * Проверяет, похоже ли имя состояния на "Review" / "На проверке".
 */
export function isReviewState(stateName) {
  if (!stateName) return false;
  const s = String(stateName).toLowerCase();
  return (
    s === 'review' ||
    s === 'in review' ||
    s.includes('провер') // "На проверке", "Проверка"
  );
}
