# Study Platform

Веб-платформа для частного репетитора по математике. Проект развивается по ТЗ из файла `Техническое задание.pdf`.

## Текущий этап

Этап 2: backend API + постоянное хранение в PostgreSQL.

Реализовано:

- единый локальный сервер, который отдаёт frontend и `/api`;
- PostgreSQL-база с моделями пользователей, учеников, заданий, занятий, уведомлений и сессий;
- хеширование паролей через PBKDF2;
- авторизация по bearer-токену;
- seed-данные из ТЗ;
- разграничение ролей учителя и ученика на backend;
- создание учеников;
- создание домашних заданий для одного или нескольких учеников;
- отправка решения учеником;
- проверка задания учителем;
- создание занятий;
- внутренние уведомления.

## Запуск

1. Установить зависимости:

```bash
python -m pip install -r requirements.txt
```

2. Запустить PostgreSQL:

```bash
docker compose up -d postgres
```

3. Запустить приложение:

```bash
python backend/server.py
```

После запуска открыть:

```text
http://127.0.0.1:5173
```

По умолчанию проектный PostgreSQL из Docker доступен на хостовом порту `55432`, чтобы не конфликтовать с локальным PostgreSQL на `5432`.

Если порт занят:

```bash
$env:STUDY_PLATFORM_PORT=5174
python backend/server.py
```

## Тестовые аккаунты

Учитель:

- Email: `kirillsaitov44@gmail.com`
- Password: `Teacher123!`

Ученик 1:

- Email: `saitovkiril@yandex.ru`
- Password: `Student123!`

Ученик 2:

- Email: `student2@example.com`
- Password: `Student123!`

## Файлы этапа

- `backend/server.py` - backend API, static server, PostgreSQL-схема и seed.
- `docker-compose.yml` - локальный PostgreSQL для разработки.
- `requirements.txt` - Python-зависимости backend.
- `src/app.js` - frontend, подключённый к API.
- `src/styles.css` - светлый адаптивный интерфейс.
- `docs/api.md` - описание текущих API-эндпоинтов.
- `docs/roadmap.md` - поэтапный план развития.

## Следующие этапы

1. Добавить загрузку файлов решений и материалов с ограничениями из ТЗ.
2. Добавить миграции отдельными файлами.
3. Подключить PWA/service worker и реальные push-уведомления.
4. Перевести backend на Django Rest Framework, если потребуется production-стек из ТЗ.
