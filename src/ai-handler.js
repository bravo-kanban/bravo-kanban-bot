/**
 * ai-handler.js — /ai command handler
 *
 * Analyzes the issue and posts a structured analysis comment.
 */

import { nowMoscow } from './config.js';
import { analyzeIssueLLM } from './llm-client.js';
import { upsertBotComment } from './github-client.js';

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

// ─── Main AI handler ──────────────────────────────────────────────────────────

/**
 * Handle /ai command on an issue.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @param {object} params.issue
 */
export async function handleAI(octokit, { owner, repo, issueNumber, issue }) {
  try {
    const title = issue.title || '';
    const body = issue.body || '';

    console.log(`[ai] Analyzing ${owner}/${repo}#${issueNumber}`);

    // Post "thinking" comment
    await upsertBotComment(
      octokit, owner, repo, issueNumber, AI_MARKER,
      `${AI_MARKER}\n## 🤖 AI думает...\n\nАнализирую задачу. Это может занять до 60 секунд.`,
    );

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

    const commentBody = `${AI_MARKER}\n## 🤖 AI-анализ задачи\n\n*Проверено: ${nowMoscow()}*\n\n| Параметр | Значение |\n|---|---|\n| 🎯 Приоритет | ${priorityBadge(priority)} |\n| 🏷️ Тип | ${typeBadge(type)} |\n| 📊 Сложность | ${complexityBadge(complexity)} |\n\n### 📝 Резюме\n${summary}\n\n---\n*Анализ выполнен автоматически. Для повторного анализа напишите \`/ai\` или \`@ai\` в комментарии.*`;

    // Replace "thinking" with result
    await upsertBotComment(octokit, owner, repo, issueNumber, AI_MARKER, commentBody);
    console.log(`[ai] Posted analysis for ${owner}/${repo}#${issueNumber}`);
  } catch (err) {
    console.error(`[ai] handleAI error: ${err.message}`);
    try {
      await upsertBotComment(
        octokit, owner, repo, issueNumber, AI_MARKER,
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
  return /[\/\@]ai\b/i.test(body);
}
