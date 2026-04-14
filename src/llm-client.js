/**
 * llm-client.js — AI integration (awstore / OpenAI-compatible API)
 *
 * Uses awstore.cloud by default (Claude Sonnet 4.5).
 * Also supports OpenRouter or any OpenAI-compatible endpoint.
 * Never crashes the calling code — returns null on any failure.
 */

import { AI_API_KEY, AI_BASE_URL, AI_MODEL, AI_MODEL_FALLBACK } from './config.js';

/**
 * Call AI model via OpenAI-compatible API. Returns parsed content string or null.
 * @param {string} model
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @returns {Promise<string|null>}
 */
async function callModel(model, messages, opts = {}) {
  const { maxTokens = 1024, temperature = 0.3 } = opts;

  const url = `${AI_BASE_URL}/v1/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AI API HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from AI');
  return content;
}

/**
 * Call LLM with primary model, fallback to secondary on failure.
 * Returns null if both models fail or no API key is configured.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts]
 * @returns {Promise<string|null>}
 */
export async function callLLM(messages, opts = {}) {
  if (!AI_API_KEY) {
    return null;
  }

  try {
    const result = await callModel(AI_MODEL, messages, opts);
    return result;
  } catch (primaryErr) {
    console.warn(`[llm] Primary model (${AI_MODEL}) failed: ${primaryErr.message}`);
    if (AI_MODEL_FALLBACK && AI_MODEL_FALLBACK !== AI_MODEL) {
      try {
        const result = await callModel(AI_MODEL_FALLBACK, messages, opts);
        return result;
      } catch (fallbackErr) {
        console.error(`[llm] Fallback model also failed: ${fallbackErr.message}`);
        return null;
      }
    }
    return null;
  }
}

/**
 * Parse JSON from LLM response (strips markdown fences if present).
 * @param {string|null} raw
 * @returns {object|null}
 */
function parseJSON(raw) {
  if (!raw) return null;
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Ask LLM to check atomicity of an issue.
 * @param {string} title
 * @param {string} body
 * @returns {Promise<{pass: boolean, comment: string}|null>}
 */
export async function checkAtomicityLLM(title, body) {
  const messages = [
    {
      role: 'system',
      content:
        'Ты эксперт по kanban и управлению задачами. Отвечай ТОЛЬКО валидным JSON без markdown.',
    },
    {
      role: 'user',
      content: `Проверь атомарность задачи. Задача атомарна, если: одна задача = одна поставка, усилие ≤5 дней, нет 3+ независимых подзадач без объединяющей цели.

Заголовок: "${title}"
Описание: "${body?.slice(0, 800) || ''}"

Верни JSON: {"pass": true/false, "comment": "краткое объяснение на русском, 1 предложение"}`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 200, temperature: 0.2 });
  return parseJSON(raw);
}

/**
 * Ask LLM to check SMART criteria.
 * @param {string} title
 * @param {string} body
 * @returns {Promise<{pass: boolean, comment: string}|null>}
 */
export async function checkSmartLLM(title, body) {
  const messages = [
    {
      role: 'system',
      content:
        'Ты эксперт по kanban и управлению задачами. Отвечай ТОЛЬКО валидным JSON без markdown.',
    },
    {
      role: 'user',
      content: `Проверь SMART-формулировку задачи. Заголовок должен содержать глагол + объект (конкретное действие). Размытые глаголы типа "Исследовать", "Посмотреть", "Разобраться", "Изучить", "Ознакомиться", "Проанализировать" — FAIL.

Заголовок: "${title}"
Описание: "${body?.slice(0, 500) || ''}"

Верни JSON: {"pass": true/false, "comment": "краткое объяснение на русском, 1 предложение"}`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 200, temperature: 0.2 });
  return parseJSON(raw);
}

/**
 * Ask LLM to check DoD section quality.
 * @param {string} body
 * @returns {Promise<{pass: boolean, comment: string}|null>}
 */
export async function checkDoDLLM(body) {
  const messages = [
    {
      role: 'system',
      content:
        'Ты эксперт по kanban и управлению задачами. Отвечай ТОЛЬКО валидным JSON без markdown.',
    },
    {
      role: 'user',
      content: `Проверь раздел "Критерии готовности" / DoD в описании задачи. Критерии должны быть конкретными и проверяемыми. Расплывчатые фразы ("всё работает", "проверено", "готово") — FAIL.

Описание: "${body?.slice(0, 1000) || ''}"

Верни JSON: {"pass": true/false, "comment": "краткое объяснение на русском, 1 предложение"}`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 200, temperature: 0.2 });
  return parseJSON(raw);
}

/**
 * Ask LLM to check that all info is in the system (not vague references).
 * @param {string} body
 * @returns {Promise<{pass: boolean, comment: string}|null>}
 */
export async function checkInSystemLLM(body) {
  const messages = [
    {
      role: 'system',
      content:
        'Ты эксперт по kanban и управлению задачами. Отвечай ТОЛЬКО валидным JSON без markdown.',
    },
    {
      role: 'user',
      content: `Проверь, что описание задачи самодостаточно — не содержит отсылок к внешним обсуждениям ("как обсуждали", "как договорились", "см. чат") и содержит всю необходимую информацию.

Описание: "${body?.slice(0, 800) || ''}"

Верни JSON: {"pass": true/false, "comment": "краткое объяснение на русском, 1 предложение"}`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 200, temperature: 0.2 });
  return parseJSON(raw);
}

/**
 * Ask LLM to suggest team routing.
 * @param {string} title
 * @param {string} body
 * @param {string[]} candidates — array of member IDs sorted by keyword score
 * @returns {Promise<{id: string, reasoning: string}|null>}
 */
export async function suggestRoutingLLM(title, body, candidates) {
  if (!candidates || candidates.length === 0) return null;

  const messages = [
    {
      role: 'system',
      content:
        'Ты помощник по маршрутизации задач. Отвечай ТОЛЬКО валидным JSON без markdown.',
    },
    {
      role: 'user',
      content: `На основе задачи выбери наиболее подходящего исполнителя из списка.

Задача: "${title}"
Описание: "${body?.slice(0, 600) || ''}"

Кандидаты (ID: зоны ответственности):
${candidates.join('\n')}

Верни JSON: {"id": "ID исполнителя", "reasoning": "краткое обоснование на русском, 1-2 предложения"}`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 300, temperature: 0.3 });
  return parseJSON(raw);
}

/**
 * Ask LLM to analyze issue for /ai command.
 * @param {string} title
 * @param {string} body
 * @returns {Promise<{priority: string, type: string, complexity: string, summary: string}|null>}
 */
export async function analyzeIssueLLM(title, body) {
  const messages = [
    {
      role: 'system',
      content:
        'Ты аналитик задач kanban-системы. Отвечай ТОЛЬКО валидным JSON без markdown.',
    },
    {
      role: 'user',
      content: `Проанализируй задачу и верни структурированный анализ.

Заголовок: "${title}"
Описание: "${body?.slice(0, 1500) || ''}"

Верни JSON:
{
  "priority": "critical|high|medium|low",
  "type": "bug|feature|improvement|docs|research",
  "complexity": "XS|S|M|L|XL",
  "summary": "краткое резюме задачи на русском, 2-3 предложения"
}`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 400, temperature: 0.3 });
  return parseJSON(raw);
}

/**
 * Generate role-based AI trigger comment.
 * @param {string} role
 * @param {string} status
 * @param {string} title
 * @param {string} body
 * @returns {Promise<string|null>}
 */
export async function generateAITriggerLLM(role, status, title, body) {
  const messages = [
    {
      role: 'system',
      content:
        'Ты AI-ассистент команды разработки. Пиши конкретные, практические рекомендации на русском языке.',
    },
    {
      role: 'user',
      content: `Задача переведена в статус "${status}". Роль исполнителя: ${role}.

Заголовок: "${title}"
Описание: "${body?.slice(0, 800) || ''}"

Сформируй краткий практический совет или шаблон для исполнителя в роли "${role}" применительно к этой конкретной задаче. 3-5 пунктов.`,
    },
  ];

  const raw = await callLLM(messages, { maxTokens: 500, temperature: 0.5 });
  return raw;
}
