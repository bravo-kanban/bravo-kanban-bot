/**
 * ai-handler.js — /ai command handler
 *
 * Analyzes the issue and posts a structured analysis comment.
 * Works with both GitHub and Linear via the platform adapter.
 *
 * Usage:
 *   /ai                    — analyze the issue (priority, type, complexity)
 *   /ai <вопрос>           — ask a free-form question about the issue
 *   @ai <вопрос>           — same as above
 */

import { nowMoscow } from './config.js';
import { analyzeIssueLLM, callLLM } from './llm-client.js';

const AI_MARKER = '<!-- ai-analysis -->';

// ─── Regex-based fallback analysis ───────────────────────────────────────────

function analyzeIssueRegex(title, body) {
  const text = `${title} ${body || ''}`.toLowerCase();

  // Priority heuristics
  let priority = 'medium';
  if (/критич|urgent|asap|срочно|блокир|critical|blocker/i.test(text)) priority = 'critical';
  else if (/важн|high|высок|приоритет/i.test(text)) priority = 'high';
  else if (/низк|low|потом|minor/i.test(text)) priority = 'low';

  // Type heuristics
  let type = 'feature';
  if (/баг|bug|ошибка|error|fix|исправ/i.test(text)) type = 'bug';
  else if (/улучш|improve|refactor|оптим/i.test(text)) type = 'improvement';
  else if (/докум|docs|readme|инструк/i.test(text)) type = 'docs';
  else if (/исследован|анализ|research|изучени/i.test(text)) type = 'research';

  // Complexity heuristics
  const bodyLen = (body || '').length;
  const checkboxCount = (body || '').match(/- \[[ xX]\]/g)?.length || 0;
  let complexity = 'M';
  if (bodyLen < 100 && checkboxCount === 0) complexity = 'XS';
  else if (bodyLen < 300 && checkboxCount <= 2) complexity = 'S';
  else if (bodyLen > 1000 || checkboxCount > 5) complexity = 'L';
  else if (bodyLen > 2000 || checkboxCount > 10) complexity = 'XL';

  const summary = `Задача "${title}" — ${type} с приоритетом ${priority}. Оценка сложности: ${complexity}.`;

  return { priority, type, complexity, summary };
}

// ─── Priority emoji ───────────────────────────────────────────────────────────

function priorityBadge(p) {
  switch (p) {
    case 'critical': return '🔴 Critical';
    case 'high': return '🟠 High';
    case 'medium': return '🟡 Medium';
    case 'low': return '🟢 Low';
    default: return p;
  }
}

function typeBadge(t) {
  switch (t) {
    case 'bug': return '🐛 Bug';
    case 'feature': return '✨ Feature';
    case 'improvement': return '⚡ Improvement';
    case 'docs': return '📝 Docs';
    case 'research': return '🔬 Research';
    default: return t;
  }
}

function complexityBadge(c) {
  switch (c) {
    case 'XS': return '🟩 XS (< 2ч)';
    case 'S': return '🟦 S (полдня)';
    case 'M': return '🟨 M (1-2 дня)';
    case 'L': return '🟧 L (3-5 дней)';
    case 'XL': return '🟥 XL (> 5 дней)';
    default: return c;
  }
}

// ─── Extract user question from /ai command ──────────────────────────────────

/**
 * Extract the user's question from a /ai or @ai comment.
 * Returns null if it's just "/ai" with no question.
 * @param {string} body
 * @returns {string|null}
 */
function extractAIQuestion(body) {
  if (!body) return null;
  const match = body.match(/[\/\\@]ai\s+(.+)/is);
  if (!match) return null;
  const question = match[1].trim();
  return question.length > 0 ? question : null;
}

// ─── Free-form AI Q&A ─────────────────────────────────────────────────────────

/**
 * Answer a free-form user question in the context of an issue.
 * @param {object} params
 * @param {string} params.question — user's question text
 * @param {string} params.title — issue title
 * @param {string} params.body — issue body/description
 * @param {object} params.platform — platform adapter
 */
async function handleAIQuestion({ question, title, body, platform }) {
  // Post "thinking" comment
  const thinkingComment = await platform.postComment(
    `${AI_MARKER}\n## 🤖 AI думает...\n\nОбрабатываю вопрос. Это может занять до 60 секунд.`,
  );
  const thinkingId = thinkingComment?.id;

  try {
    const messages = [
      {
        role: 'system',
        content: 'Ты AI-помощник команды. Отвечай на русском языке, кратко и по делу. Ты находишься в контексте задачи в kanban-системе.',
      },
      {
        role: 'user',
        content: `Контекст задачи:\nЗаголовок: "${title}"\nОписание: "${body?.slice(0, 2000) || 'пусто'}"\n\nВопрос: ${question}`,
      },
    ];

    const answer = await callLLM(messages, { maxTokens: 1000, temperature: 0.5 });

    const resultBody = answer
      ? `${AI_MARKER}\n## 🤖 AI-ответ\n\n*${nowMoscow()}*\n\n> ${question}\n\n${answer}\n\n---\n*Для нового вопроса напишите \`/ai <вопрос>\`*`
      : `${AI_MARKER}\n## ❌ AI недоступен\n\nНе удалось получить ответ от AI. Попробуйте позже.`;

    if (thinkingId) {
      await platform.updateComment(thinkingId, resultBody);
    } else {
      await platform.postComment(resultBody);
    }
    console.log(`[ai] Answered question on ${platform.issueKey}`);
  } catch (err) {
    console.error(`[ai] handleAIQuestion error: ${err.message}`);
    const errBody = `${AI_MARKER}\n## ❌ Ошибка AI\n\n${err.message}`;
    if (thinkingId) {
      await platform.updateComment(thinkingId, errBody).catch(() => {});
    } else {
      await platform.postComment(errBody).catch(() => {});
    }
  }
}

// ─── Main AI handler (issue analysis) ────────────────────────────────────────

/**
 * Handle /ai command on an issue.
 * Uses the platform adapter for posting comments (works with both GitHub and Linear).
 *
 * @param {object} params
 * @param {object} params.issue — { title, body }
 * @param {object} params.platform — platform adapter (postComment, updateComment)
 * @param {string} [params.commentBody] — the original comment with /ai command (to extract question)
 */
export async function handleAI({ issue, platform, commentBody }) {
  // Check if user asked a specific question
  const question = extractAIQuestion(commentBody);
  if (question) {
    return handleAIQuestion({
      question,
      title: issue.title || '',
      body: issue.body || '',
      platform,
    });
  }

  // Default: analyze the issue
  try {
    const title = issue.title || '';
    const body = issue.body || '';

    console.log(`[ai] Analyzing ${platform.issueKey}`);

    // Post "thinking" comment (new comment every time)
    const thinkingComment = await platform.postComment(
      `${AI_MARKER}\n## 🤖 AI думает...\n\nАнализирую задачу. Это может занять до 60 секунд.`,
    );
    const thinkingId = thinkingComment?.id;

    // Try LLM analysis
    let analysis = null;
    const llmResult = await analyzeIssueLLM(title, body);
    if (llmResult) {
      analysis = llmResult;
    } else {
      // Fallback to regex
      analysis = analyzeIssueRegex(title, body);
    }

    const { priority, type, complexity, summary } = analysis;

    const resultBody = `${AI_MARKER}\n## 🤖 AI-анализ задачи\n\n*Проверено: ${nowMoscow()}*\n\n| Параметр | Значение |\n|---|---|\n| 🎯 Приоритет | ${priorityBadge(priority)} |\n| 🏷️ Тип | ${typeBadge(type)} |\n| 📊 Сложность | ${complexityBadge(complexity)} |\n\n### 📝 Резюме\n${summary}\n\n---\n*Анализ выполнен автоматически. Для повторного анализа напишите \`/ai\`, для вопроса — \`/ai <вопрос>\`.*`;

    // Replace "thinking" with result
    if (thinkingId) {
      await platform.updateComment(thinkingId, resultBody);
    } else {
      await platform.postComment(resultBody);
    }
    console.log(`[ai] Posted analysis for ${platform.issueKey}`);
  } catch (err) {
    console.error(`[ai] handleAI error: ${err.message}`);
    try {
      await platform.postComment(
        `${AI_MARKER}\n## ❌ Ошибка AI-анализа\n\n${err.message}`,
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Check if a comment contains the /ai or @ai command.
 * @param {string} body
 * @returns {boolean}
 */
export function isAICommand(body) {
  if (!body) return false;
  return /[\/\\@]ai\b/i.test(body);
}
