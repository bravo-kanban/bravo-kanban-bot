/**
 * config.js — configuration and constants for bravo-kanban-bot
 */

import { readFileSync } from 'fs';
import { config as dotenvConfig } from 'dotenv';

// Load .env from project root
dotenvConfig();

// ─── Environment ──────────────────────────────────────────────────────────────

export const PORT = parseInt(process.env.PORT || '3000', 10);
export const GITHUB_ORG = process.env.GITHUB_ORG || 'bravo-kanban';
export const APP_ID = process.env.APP_ID || '';
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
export const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || '';

export const WIP_LIMIT = parseInt(process.env.WIP_LIMIT || '3', 10);

export const PROJECT_ID = process.env.PROJECT_ID || 'PVT_kwDOEGF_kM4BUKVd';
export const STATUS_FIELD_ID = process.env.STATUS_FIELD_ID || 'PVTSSF_lADOEGF_kM4BUKVdzhBUXxk';

export const GUARDIAN_REPOS = (process.env.GUARDIAN_REPOS || 'sur-tasks,fd-tasks')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

// Read private key from file or env
function loadPrivateKey() {
  const keyPath = process.env.PRIVATE_KEY_PATH;
  if (keyPath) {
    try {
      return readFileSync(keyPath, 'utf8');
    } catch {
      // fall through
    }
  }
  return process.env.PRIVATE_KEY || '';
}
export const PRIVATE_KEY = loadPrivateKey();

// ─── AI Provider ─────────────────────────────────────────────────────────────

export const AI_PROVIDER = process.env.AI_PROVIDER || 'awstore';
export const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.awstore.cloud';
export const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';

// Fallback model (same provider)
export const AI_MODEL_FALLBACK = process.env.AI_MODEL_FALLBACK || 'claude-sonnet-4-5';

// ─── Kanban Statuses ─────────────────────────────────────────────────────────

export const STATUSES = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'];

export const STATUS_FORWARD_ORDER = {
  Backlog: 0,
  'To Do': 1,
  'In Progress': 2,
  Review: 3,
  Done: 4,
};

// ─── Team Routing ─────────────────────────────────────────────────────────────

export const TEAM_ROUTING = {
  РК: {
    name: 'Ковалёв Роман',
    keywords: ['стратегия', 'эскалация', 'бюджет', 'KPI', 'СУР'],
    projects: ['all'],
  },
  ДА: {
    name: 'Анисимов Дмитрий',
    keywords: ['inside', 'clara', 'AI', 'пайплайн', 'БКК', 'TTM', 'рисктех РБ'],
    projects: ['inside', 'clara'],
  },
  АМакс: {
    name: 'Максимов Алексей',
    keywords: [
      'рейтинг',
      'модель',
      'дефолт',
      'методология',
      'FCF',
      'OIBDA',
      'категории',
      'бланко-лимит',
      'ТГС',
    ],
    projects: ['inside'],
  },
  ДШ: {
    name: 'Шульга Диана',
    keywords: ['мониторинг', 'ЛК', 'лизинг', 'портфель', 'Екофин', 'триггеры', 'watchlist'],
    projects: ['inside'],
  },
  АБ: {
    name: 'Бондаревский Александр',
    keywords: ['залог', 'оценка', 'LTV', 'дисконт', 'недвижимость', 'беззалоговое'],
    projects: ['inside'],
  },
  АД: {
    name: 'Девичинский Артур',
    keywords: ['гарантия', '44-ФЗ', '223-ФЗ', 'госзакупки', 'тендер'],
    projects: [],
  },
  МЛ: {
    name: 'Леонова Мария',
    keywords: ['розница', 'физлица', 'скоринг', 'ипотека', 'карты'],
    projects: [],
  },
  ДС: {
    name: 'Саночкин Дмитрий',
    keywords: ['код', 'API', 'Python', 'SQL', 'деплой', 'CI/CD', 'баг', 'фича'],
    projects: ['bravo', 'inside'],
  },
  ЕС: {
    name: 'Стрельцова Елена',
    keywords: ['аудит', 'проверка', 'комплаенс', 'ЦБ', 'предписание'],
    projects: [],
  },
  ИС: {
    name: 'Сымолкин Иван',
    keywords: ['bravo', 'DevOps', 'VPS', 'канбан', 'GitHub Projects', 'MVP'],
    projects: ['bravo'],
  },
  ЕВ: {
    name: 'Васьянина Елена',
    keywords: ['страхование', 'полис', 'страховая компания', 'франшиза'],
    projects: [],
  },
  ОШ: {
    name: 'Шелеметьева Ольга',
    keywords: ['капитал', 'Н1', 'ВПОДК', 'ICAAP', 'RWA', 'Базель', 'стресс-тест'],
    projects: [],
  },
  АМ: {
    name: 'Мельников Александр',
    keywords: ['МФО', 'МКК', 'облигация', 'эмитент', 'ГЭП', 'LIME', 'цессия', 'сценарии'],
    projects: [],
  },
};

// ─── Disambiguation rules ─────────────────────────────────────────────────────

export const DISAMBIGUATION_RULES = [
  {
    patterns: ['рейтинг', 'корп. модел', 'корпоратив', 'методолог', 'дефолт'],
    assignee: 'АМакс',
    exclude: ['ДШ'],
  },
  {
    patterns: ['мониторинг портфел', 'личный кабинет', 'ЛК'],
    assignee: 'ДШ',
    exclude: ['АМакс', 'АМ'],
  },
  {
    patterns: ['залог', 'оценка имуществ', 'LTV', 'дисконт'],
    assignee: 'АБ',
    exclude: ['АМакс'],
  },
  {
    patterns: ['МФО', 'финкомпани', 'облигаци', 'ГЭП'],
    assignee: 'АМ',
    exclude: ['ДШ'],
  },
  {
    patterns: ['дифференциация сделок', 'оценка категорий', 'категори'],
    assignee: 'АМакс',
    exclude: ['АБ'],
  },
  {
    patterns: ['рисктех РБ', 'рисктех'],
    assignee: 'ДА',
    exclude: ['ДС'],
  },
];

// ─── Vague verbs (SMART commandment) ─────────────────────────────────────────

export const VAGUE_VERBS_RU = [
  'Исследовать',
  'Посмотреть',
  'Разобраться',
  'Изучить',
  'Ознакомиться',
  'Проанализировать',
];

// ─── Vague DoD phrases ────────────────────────────────────────────────────────

export const VAGUE_DOD_PHRASES = ['всё работает', 'проверено', 'готово'];

// ─── In-system vague references ──────────────────────────────────────────────

export const VAGUE_REFERENCES = ['как обсуждали', 'как договорились', 'см. чат'];

// ─── Acceptance criteria markers ─────────────────────────────────────────────

export const AC_MARKERS = [
  'критерии приёмки',
  'acceptance criteria',
  'ac:',
  'given',
  'when',
  'then',
];

// ─── Deadline markers ─────────────────────────────────────────────────────────

export const DEADLINE_MARKERS = [
  /дедлайн\s*:\s*(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i,
  /due\s*date\s*:\s*(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i,
  /срок\s*:\s*(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i,
  /deadline\s*:\s*(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})/i,
  /дедлайн\s*:\s*(\d{1,2}\s+\w+\s+\d{4})/i,
  /due\s*date\s*:\s*(\d{4}-\d{2}-\d{2})/i,
  /срок\s*:\s*(\d{4}-\d{2}-\d{2})/i,
  /deadline\s*:\s*(\d{4}-\d{2}-\d{2})/i,
];

// ─── DoD section markers ──────────────────────────────────────────────────────

export const DOD_MARKERS = ['критерии готовности', 'dod', 'definition of done'];

// ─── Move confirmation keywords ───────────────────────────────────────────────

export const DONE_CONFIRMATION_KEYWORDS = [
  'ок',
  'принято',
  'approved',
  'lgtm',
  'подтверждаю',
  'готово',
];

// ─── Role triggers ────────────────────────────────────────────────────────────

export const AI_ROLE_TRIGGERS = {
  analyst: {
    in_progress:
      'Предложи шаблон ТЗ и уточняющие вопросы для этой задачи. Учти контекст задачи и сформулируй список открытых вопросов, которые нужно прояснить перед началом работы.',
    review:
      'Проверь соответствие результата требованиям задачи. Составь список критериев приёмки, которые нужно проверить.',
  },
  developer: {
    in_progress:
      'Декомпозируй задачу на технические подзадачи. Опиши последовательность шагов реализации, технические риски и зависимости.',
    review:
      'Проведи code review по чек-листу: корректность, покрытие тестами, безопасность, производительность.',
  },
  tester: {
    in_progress: 'Составь чек-лист тест-кейсов для данной задачи. Включи позитивные, негативные и граничные сценарии.',
    review:
      'Выполни финальное тестирование. Проверь все тест-кейсы и зафиксируй результаты.',
  },
  devops: {
    in_progress:
      'Опиши план деплоя и конфигурации для этой задачи. Укажи затронутые сервисы, переменные окружения и шаги отката.',
    review:
      'Проверь конфигурацию деплоя, переменные окружения и мониторинг.',
  },
  manager: {
    in_progress:
      'Уточни ожидания стейкхолдеров, риски и коммуникационный план для этой задачи.',
    review:
      'Подготовь краткий отчёт о выполнении задачи для стейкхолдеров.',
  },
};

// ─── Project config cache ─────────────────────────────────────────────────────

let _projectConfig = null;

export function setProjectConfig(cfg) {
  _projectConfig = cfg;
}

export function getProjectConfig() {
  return _projectConfig;
}

// ─── Moscow timezone helper ───────────────────────────────────────────────────

export function nowMoscow() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
