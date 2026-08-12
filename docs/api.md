# API

Базовый адрес: `/api`.

Авторизованные запросы используют заголовок:

```text
Authorization: Bearer <token>
```

## Auth

- `POST /api/auth/login` - вход по email и паролю.
- `POST /api/auth/logout` - удаление текущей сессии.
- `GET /api/auth/me` - текущий пользователь.

## Students

- `GET /api/students` - список учеников учителя.
- `POST /api/students` - создать ученика.

Доступ: только учитель.

## Assignments

- `GET /api/assignments` - задания текущего пользователя.
- `POST /api/assignments` - создать задание.
- `POST /api/assignments/{id}/submit` - отправить решение учеником.
- `POST /api/assignments/{id}/check` - проверить работу учителем.

Доступ:

- учитель видит задания своих учеников;
- ученик видит только свои задания;
- ученик не может проверять работы;
- учитель не может отправлять решения за ученика.

## Lessons

- `GET /api/lessons` - занятия текущего пользователя.
- `POST /api/lessons` - создать занятие.

Доступ:

- учитель видит общий календарь своих занятий;
- ученик видит только свои занятия.

## Notifications

- `GET /api/notifications` - уведомления текущего пользователя.
- `POST /api/notifications/read-all` - отметить все прочитанными.
- `PATCH /api/notifications/{id}/read` - отметить одно уведомление прочитанным.
