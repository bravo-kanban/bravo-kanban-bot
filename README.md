# bravo-kanban-bot

GitHub App-бот для организации **bravo-kanban**. Автоматически проверяет задачи по 9 заповедям канбана, маршрутизирует исполнителей и обрабатывает команды `/move`, `/ai`, `/guardian`.

---

## Содержание

- [Возможности](#возможности)
- [Быстрый старт](#быстрый-старт)
- [Создание GitHub App](#создание-github-app)
- [Конфигурация](#конфигурация)
- [Деплой на сервер](#деплой-на-сервер)
- [Команды](#команды)
- [Guardian — 9 заповедей](#guardian--9-заповедей)
- [Маршрутизация команды](#маршрутизация-команды)
- [Архитектура](#архитектура)

---

## Возможности

| Функция | Описание |
|---|---|
| 🛡️ **Guardian** | Автопроверка задач по 9 заповедям канбана при создании/редактировании |
| 🗺️ **Маршрутизация** | Автоматическое предложение исполнителя из 13 членов команды |
| 🚦 **`/move`** | Перевод задачи между статусами с валидацией условий |
| 🤖 **`/ai`** | AI-анализ задачи: приоритет, тип, сложность, резюме |
| 🧠 **LLM** | Расширенные проверки через OpenRouter (опционально) |

---

## Быстрый старт

```bash
git clone <repo-url> bravo-kanban-bot
cd bravo-kanban-bot
cp .env.example .env
# Заполните .env своими значениями
# Скопируйте private-key.pem в корень проекта
docker-compose up -d
```

---

## Создание GitHub App

1. Откройте **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**

2. Заполните поля:
   - **GitHub App name:** `bravo-kanban-bot`
   - **Homepage URL:** `https://github.com/bravo-kanban`
   - **Webhook URL:** `https://<ваш-домен>/github-app`
   - **Webhook secret:** придумайте случайную строку (сохраните в `WEBHOOK_SECRET`)

3. **Permissions** (Repository):
   - `Issues` → Read & write
   - `Issue comments` → Read & write
   - `Metadata` → Read

4. **Permissions** (Organization):
   - `Members` → Read

5. **Permissions** (GitHub Projects V2 — через GraphQL, дополнительных прав не требуется при наличии Issues: R&W)

6. **Subscribe to events:**
   - ✅ Issues
   - ✅ Issue comment

7. Нажмите **Create GitHub App**

8. На странице приложения:
   - Запишите **App ID** → `APP_ID` в `.env`
   - Нажмите **Generate a private key** → скачайте `.pem` файл
   - Переименуйте в `private-key.pem` и поместите в корень проекта

9. Перейдите в **Install App** → установите на организацию `bravo-kanban`

---

## Конфигурация

Скопируйте `.env.example` в `.env` и заполните:

```env
# GitHub App
APP_ID=123456                                # ID из настроек GitHub App
PRIVATE_KEY_PATH=/app/private-key.pem       # путь к .pem файлу внутри контейнера
WEBHOOK_SECRET=ваш-секрет                    # совпадает с настройкой в GitHub App

# OpenRouter (опционально — для AI-функций)
OPENROUTER_API_KEY=sk-or-...                 # ключ с openrouter.ai

# Организация
GITHUB_ORG=bravo-kanban
GUARDIAN_REPOS=sur-tasks,sur-bravo,fd-tasks  # репозитории для WIP-проверки

# GitHub Projects V2
PROJECT_ID=PVT_kwDOEGF_kM4BUKVd
STATUS_FIELD_ID=PVTSSF_lADOEGF_kM4BUKVdzhBUXxk

# Лимиты
WIP_LIMIT=3     # макс. задач "In Progress" на исполнителя
PORT=3000
```

### Как найти PROJECT_ID и STATUS_FIELD_ID

Используйте GraphQL Explorer (github.com/settings/graphql) или `gh` CLI:

```bash
gh api graphql -f query='
  query {
    organization(login: "bravo-kanban") {
      projectsV2(first: 10) {
        nodes { id title }
      }
    }
  }
'
```

---

## Деплой на сервер

### Требования

- Docker ≥ 24.0
- docker-compose ≥ 2.0
- Публичный IP или домен (для webhook от GitHub)

### Инструкция

```bash
# 1. Клонируйте репозиторий бота на сервер
git clone <repo-url> /opt/bravo-kanban-bot
cd /opt/bravo-kanban-bot

# 2. Создайте .env
cp .env.example .env
nano .env  # заполните значения

# 3. Скопируйте private key
cp ~/bravo-kanban-bot.private-key.pem ./private-key.pem
chmod 600 private-key.pem

# 4. Запустите
docker-compose up -d

# 5. Проверьте работу
curl http://localhost:3000/health
docker-compose logs -f bot
```

### Nginx (reverse proxy)

```nginx
server {
    listen 443 ssl;
    server_name bot.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/bot.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Обновление бота

```bash
cd /opt/bravo-kanban-bot
git pull
docker-compose build --no-cache
docker-compose up -d
```

### Просмотр логов

```bash
docker-compose logs -f bot
docker-compose logs --tail=100 bot
```

---

## Команды

### `/move <статус>`

Переводит задачу в указанный статус. Проверяет условия перехода.

**Допустимые статусы:**
- `Backlog`
- `To Do`
- `In Progress`
- `Review`
- `Done`

**Примеры:**
```
/move In Progress
/move Review
/move Done
/move Backlog
```

**Условия для переходов вперёд:**

| Переход | Условия |
|---|---|
| → To Do | Заголовок >5 символов, описание >30 символов, назначен исполнитель, указан тип (label) |
| → In Progress | Все условия To Do + автор комментария = исполнитель задачи |
| → Review | In Progress + хотя бы 1 комментарий от исполнителя о выполненной работе |
| → Done | Review + подтверждение от другого участника ("Ок", "Принято", "Approved", "LGTM") |

Обратные переходы (например, `In Progress → Backlog`) **разрешены без проверок**.

После успешного перехода бот публикует AI-подсказку, адаптированную под роль исполнителя.

---

### `/ai`

Запрашивает AI-анализ задачи. Бот публикует:

- **Приоритет:** Critical / High / Medium / Low
- **Тип:** Bug / Feature / Improvement / Docs / Research
- **Сложность:** XS / S / M / L / XL
- **Резюме:** краткое описание задачи

Пример использования:
```
/ai
```

Если задан `OPENROUTER_API_KEY` — используется LLM-анализ. Без ключа — эвристики на основе текста задачи.

---

### `/guardian` | `@guardian` | `re-check`

Принудительно запускает проверку Guardian (9 заповедей). Полезно после редактирования задачи.

```
/guardian
re-check
@guardian
```

---

## Guardian — 9 заповедей

Guardian автоматически запускается при:
- Создании задачи (event: `issues.opened`)
- Редактировании задачи (event: `issues.edited`)
- Комментарии с `/guardian`, `@guardian` или `re-check`

Результат публикуется как комментарий (upsert — обновляется при повторной проверке).

### Заповеди

| # | Заповедь | Тип | Проверка |
|---|---|---|---|
| 1 | **Атомарность** | BLOCK | Одна задача = одна поставка. "И/and" в заголовке, 3+ независимых подзадачи, усилие >5 дней → FAIL |
| 2 | **SMART** | BLOCK | Заголовок: глагол + объект, не размытые глаголы. Тело: критерии приёмки (AC/given/when/then) |
| 3 | **Единый владелец** | BLOCK | Backlog: исполнитель не обязателен. To Do+: ровно ОДИН исполнитель |
| 4 | **Дедлайн** | BLOCK | Backlog: не обязателен. To Do+: "Дедлайн: ДД.ММ.ГГГГ" в теле задачи |
| 5 | **Прозрачность статуса** | WARN | In Progress без комментариев ≥2 дней → WARNING. ≥5 дней → ЭСКАЛАЦИЯ |
| 6 | **WIP-лимит** | BLOCK | Макс. 3 задачи "In Progress" на исполнителя по всем репозиториям |
| 7 | **Definition of Done** | BLOCK | Раздел "Критерии готовности" / DoD + ≥1 чекбокс. Расплывчатые критерии → FAIL |
| 8 | **Всё в системе** | BLOCK | Описание ≥30 символов, нет отсылок "как обсуждали", "см. чат" |
| 9 | **Бэклог-груминг** | WARN | Backlog >30 дней → WARNING. >60 дней → рекомендация архивировать |

### Вердикты

| Вердикт | Условие |
|---|---|
| ✅ PASSED | Все BLOCK-заповеди пройдены, предупреждений нет |
| ⚠️ PASSED WITH WARNINGS | BLOCK пройдены, есть предупреждения (заповеди 5, 9) |
| 🚫 BLOCKED | Хотя бы одна BLOCK-заповедь не выполнена |

---

## Маршрутизация команды

После проверки заповедей Guardian предлагает исполнителя из 13 членов команды:

| ID | Имя | Специализация |
|---|---|---|
| РК | Ковалёв Роман | Стратегия, эскалации, бюджет, KPI |
| ДА | Анисимов Дмитрий | Inside, Clara, AI, пайплайны, рисктех РБ |
| АМакс | Максимов Алексей | Рейтинговые модели, методология, дефолты |
| ДШ | Шульга Диана | Мониторинг, ЛК, лизинг, портфель |
| АБ | Бондаревский Александр | Залоги, оценка, LTV, недвижимость |
| АД | Девичинский Артур | Гарантии, 44-ФЗ, 223-ФЗ, госзакупки |
| МЛ | Леонова Мария | Розница, физлица, скоринг, ипотека |
| ДС | Саночкин Дмитрий | Код, API, Python, SQL, CI/CD |
| ЕС | Стрельцова Елена | Аудит, комплаенс, ЦБ |
| ИС | Сымолкин Иван | Bravo, DevOps, канбан, MVP |
| ЕВ | Васьянина Елена | Страхование, полисы |
| ОШ | Шелеметьева Ольга | Капитал, Н1, ВПОДК, Базель |
| АМ | Мельников Александр | МФО, облигации, ГЭП, LIME |

Алгоритм маршрутизации:
1. Подсчёт совпадений ключевых слов в заголовке + описании
2. Применение правил disambiguation (приоритет по типу задачи)
3. LLM-уточнение при наличии `OPENROUTER_API_KEY`

---

## Архитектура

```
bravo-kanban-bot/
├── src/
│   ├── index.js          # Express + @octokit/app, маршрутизатор событий
│   ├── guardian.js        # 9 заповедей канбана
│   ├── team-routing.js    # Матрица маршрутизации команды
│   ├── move-handler.js    # Обработчик /move с переходами статусов
│   ├── ai-handler.js      # Обработчик /ai
│   ├── llm-client.js      # OpenRouter API (primary + fallback модель)
│   ├── github-client.js   # GitHub REST + GraphQL helpers
│   └── config.js          # Конфигурация, константы, env
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

**Технологии:**
- Node.js ≥ 20 (ESM)
- `@octokit/app` — GitHub App authentication
- `@octokit/graphql` — GitHub Projects V2 mutations
- `express` — HTTP сервер и webhook endpoint
- HMAC-SHA256 — верификация подписи вебхуков
- OpenRouter API — LLM (llama-4-scout, deepseek-chat)

**GitHub Projects V2:**
Статус задачи изменяется через GraphQL мутацию `updateProjectV2ItemFieldValue`. ID опций статусов получаются динамически при запуске и кэшируются.

---

## Разработка

```bash
# Без Docker
npm install
cp .env.example .env
# Заполните .env
node src/index.js

# С auto-reload
npm run dev
```

Для тестирования вебхуков локально используйте [smee.io](https://smee.io) или [ngrok](https://ngrok.com):

```bash
npx smee-client --url https://smee.io/your-channel --path /github-app --port 3000
```

---

## Лицензия

MIT
