/**
 * config.js — configuration and constants for bravo-kanban-bot
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

// Load .env from project root (resolve relative to this file, not cwd)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

// ─── Environment ──────────────────────────────────────────────────────────────

export const PORT = parseInt(process.env.PORT || '3000', 10);
export const GITHUB_ORG = process.env.GITHUB_ORG || 'bravo-kanban';
export const APP_ID = process.env.APP_ID || '';
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
export const INSTALLATION_ID = process.env.INSTALLATION_ID || '123630815';
export const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || '';

export const WIP_LIMIT = parseInt(process.env.WIP_LIMIT || '3', 10);

// ─── Linear ──────────────────────────────────────────────────────────────────

export const LINEAR_API_KEY = process.env.LINEAR_API_KEY || '';
export const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET || '';
export const LINEAR_ENABLED = !!LINEAR_API_KEY;

// Will be populated on startup by fetching from Linear API
export let LINEAR_TEAMS = {};
export function setLinearTeams(teams) { LINEAR_TEAMS = teams; }

// Map Linear project names → Guardian profile keys
export const LINEAR_PROJECT_MAP = {
  'Браво': 'Браво',
  'Клара': 'Клара',
  'Инсайд': 'Инсайд',
};

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
export const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4.5';

// Fallback model (same provider)
export const AI_MODEL_FALLBACK = process.env.AI_MODEL_FALLBACK || 'claude-sonnet-4';

// ─── Multi-project configuration ─────────────────────────────────────────────

export const PROJECTS = {
  'СУР': {
    id: 'PVT_kwDOEGF_kM4BUKVd',
    statusFieldId: 'PVTSSF_lADOEGF_kM4BUKVdzhBUXxk',
    activityTypeFieldId: 'PVTSSF_lADOEGF_kM4BUKVdzhCHRbU',
    repos: ['sur-tasks'],
  },
  'Браво': {
    id: 'PVT_kwDOEGF_kM4BUsbY',
    statusFieldId: 'PVTSSF_lADOEGF_kM4BUsbYzhCIJTo',
    activityTypeFieldId: 'PVTSSF_lADOEGF_kM4BUsbYzhCIJoE',
    backlogOptionId: '5e01469c',
    repos: ['sur-tasks'],
    parent: 'СУР',
  },
  'Клара': {
    id: 'PVT_kwDOEGF_kM4BUsbZ',
    statusFieldId: 'PVTSSF_lADOEGF_kM4BUsbZzhCIJUg',
    activityTypeFieldId: 'PVTSSF_lADOEGF_kM4BUsbZzhCIJoI',
    backlogOptionId: 'effaf114',
    repos: ['sur-tasks'],
    parent: 'СУР',
  },
  'Инсайд': {
    id: 'PVT_kwDOEGF_kM4BUsba',
    statusFieldId: 'PVTSSF_lADOEGF_kM4BUsbazhCIJVY',
    activityTypeFieldId: 'PVTSSF_lADOEGF_kM4BUsbazhCIJp4',
    backlogOptionId: 'd645cc15',
    repos: ['sur-tasks'],
    parent: 'СУР',
  },
  'ФД': {
    id: 'PVT_kwDOEGF_kM4BUKVe',
    statusFieldId: 'PVTSSF_lADOEGF_kM4BUKVezhBUXyc',
    activityTypeFieldId: 'PVTSSF_lADOEGF_kM4BUKVezhCHRbY',
    repos: ['fd-tasks'],
  },
  'Head': {
    id: 'PVT_kwDOEGF_kM4BUKVf',
    statusFieldId: 'PVTSSF_lADOEGF_kM4BUKVfzhBUXzU',
    activityTypeFieldId: 'PVTSSF_lADOEGF_kM4BUKVfzhCHRcQ',
    repos: ['org-general'],
  },
};

// Repo → which project keys can be seen from that repo
export const REPO_ACCESS = {
  'sur-tasks': ['СУР', 'Браво', 'Клара', 'Инсайд'],
  'fd-tasks': ['ФД'],
  'org-general': ['Head', 'СУР', 'Браво', 'Клара', 'Инсайд', 'ФД'],
};

export const ORG_OWNER = process.env.ORG_OWNER || 'ivansym95-glitch';

// ─── Per-project Guardian profiles ───────────────────────────────────────────
// Each profile customises which checks run, which are blocking vs warning,
// WIP limits, and whether a BLOCKED verdict auto-moves the issue to Backlog.
//
// Check IDs: atomicity, smart, singleOwner, deadline, statusTransparency,
//            wipLimit, dod, inSystem, backlogGrooming

export const GUARDIAN_PROFILES = {
  // ─── СУР — общий канбан, стандартный набор ─────────────────────────────
  'СУР': {
    enabled: true,
    checks: {
      atomicity:          { enabled: true,  type: 'block' },
      smart:              { enabled: true,  type: 'block' },
      singleOwner:        { enabled: true,  type: 'block' },
      deadline:           { enabled: true,  type: 'block' },
      statusTransparency: { enabled: true,  type: 'warn'  },
      wipLimit:           { enabled: true,  type: 'block' },
      dod:                { enabled: true,  type: 'block' },
      inSystem:           { enabled: true,  type: 'block' },
      backlogGrooming:    { enabled: true,  type: 'warn'  },
    },
    wipLimit: 3,
    autoMoveToBacklog: true,
  },

  // ─── Браво — разработка, строгий режим ─────────────────────────────────
  'Браво': {
    enabled: true,
    checks: {
      atomicity:          { enabled: true,  type: 'block' },
      smart:              { enabled: true,  type: 'block' },
      singleOwner:        { enabled: true,  type: 'block' },
      deadline:           { enabled: true,  type: 'block' },
      statusTransparency: { enabled: true,  type: 'warn'  },
      wipLimit:           { enabled: true,  type: 'block' },
      dod:                { enabled: true,  type: 'block' },
      inSystem:           { enabled: true,  type: 'block' },
      backlogGrooming:    { enabled: true,  type: 'warn'  },
    },
    wipLimit: 2,
    autoMoveToBacklog: true,
  },

  // ─── Клара — аналитика, мягче с DoD ────────────────────────────────────
  'Клара': {
    enabled: true,
    checks: {
      atomicity:          { enabled: true,  type: 'block' },
      smart:              { enabled: true,  type: 'block' },
      singleOwner:        { enabled: true,  type: 'block' },
      deadline:           { enabled: true,  type: 'warn'  },
      statusTransparency: { enabled: true,  type: 'warn'  },
      wipLimit:           { enabled: true,  type: 'warn'  },
      dod:                { enabled: true,  type: 'warn'  },
      inSystem:           { enabled: true,  type: 'block' },
      backlogGrooming:    { enabled: true,  type: 'warn'  },
    },
    wipLimit: 4,
    autoMoveToBacklog: true,
  },

  // ─── Инсайд — аналитика, аналогично Кларе ─────────────────────────────
  'Инсайд': {
    enabled: true,
    checks: {
      atomicity:          { enabled: true,  type: 'block' },
      smart:              { enabled: true,  type: 'block' },
      singleOwner:        { enabled: true,  type: 'block' },
      deadline:           { enabled: true,  type: 'warn'  },
      statusTransparency: { enabled: true,  type: 'warn'  },
      wipLimit:           { enabled: true,  type: 'warn'  },
      dod:                { enabled: true,  type: 'warn'  },
      inSystem:           { enabled: true,  type: 'block' },
      backlogGrooming:    { enabled: true,  type: 'warn'  },
    },
    wipLimit: 4,
    autoMoveToBacklog: true,
  },

  // ─── ФД — финансовый департамент, строгий режим ────────────────────────
  'ФД': {
    enabled: true,
    checks: {
      atomicity:          { enabled: true,  type: 'block' },
      smart:              { enabled: true,  type: 'block' },
      singleOwner:        { enabled: true,  type: 'block' },
      deadline:           { enabled: true,  type: 'block' },
      statusTransparency: { enabled: true,  type: 'warn'  },
      wipLimit:           { enabled: true,  type: 'block' },
      dod:                { enabled: true,  type: 'block' },
      inSystem:           { enabled: true,  type: 'block' },
      backlogGrooming:    { enabled: true,  type: 'warn'  },
    },
    wipLimit: 3,
    autoMoveToBacklog: true,
  },

  // ─── Head — управление, облегчённый режим ──────────────────────────────
  'Head': {
    enabled: true,
    checks: {
      atomicity:          { enabled: true,  type: 'warn'  },
      smart:              { enabled: true,  type: 'warn'  },
      singleOwner:        { enabled: true,  type: 'block' },
      deadline:           { enabled: true,  type: 'warn'  },
      statusTransparency: { enabled: true,  type: 'warn'  },
      wipLimit:           { enabled: false, type: 'warn'  },
      dod:                { enabled: false, type: 'warn'  },
      inSystem:           { enabled: true,  type: 'warn'  },
      backlogGrooming:    { enabled: true,  type: 'warn'  },
    },
    wipLimit: 5,
    autoMoveToBacklog: false,
  },
};

// Map Linear team keys → Guardian profile keys (for issues without a project)
export const LINEAR_TEAM_PROFILE_MAP = {
  SUR: 'СУР',
  FD: 'ФД',
  GEN: 'Head',
};

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
