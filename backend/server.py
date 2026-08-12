from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import smtplib
import sys
import uuid
from datetime import datetime, timezone
from email.message import EmailMessage
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    import psycopg
    from psycopg import IntegrityError as DatabaseIntegrityError
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - handled at runtime with a clear message.
    psycopg = None
    DatabaseIntegrityError = Exception
    dict_row = None


ROOT = Path(__file__).resolve().parents[1]


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(ROOT / ".env")

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://study_platform:study_platform@127.0.0.1:55432/study_platform",
)
HOST = os.environ.get("STUDY_PLATFORM_HOST", "127.0.0.1")
PORT = int(os.environ.get("STUDY_PLATFORM_PORT", "5173"))
PBKDF2_ITERATIONS = 120_000
SMTP_HOST = os.environ.get("SMTP_HOST", "").strip()
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587") or 587)
SMTP_USER = os.environ.get("SMTP_USER", "").strip()
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "").strip()
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER).strip()
SMTP_USE_TLS = os.environ.get("SMTP_USE_TLS", "true").lower() not in ("0", "false", "no", "off")
SMTP_USE_SSL = os.environ.get("SMTP_USE_SSL", "true" if SMTP_PORT == 465 else "false").lower() not in ("0", "false", "no", "off")
SMTP_TIMEOUT = int(os.environ.get("SMTP_TIMEOUT", "30") or 30)
EMAIL_NOTIFICATIONS_ENABLED = os.environ.get("EMAIL_NOTIFICATIONS_ENABLED", "true").lower() not in ("0", "false", "no", "off")


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student', 'parent')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS student_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grade TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  student_bio TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#3B82F6',
  paid_lessons INTEGER NOT NULL DEFAULT 0,
  lesson_price INTEGER NOT NULL DEFAULT 0,
  meeting_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parent_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS student_groups (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#1267F3',
  paid_lessons INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS student_group_members (
  group_id TEXT NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, student_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  max_score INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignment_recipients (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new',
  submitted_at TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT '',
  score_percent INTEGER,
  score_points INTEGER,
  score_max INTEGER,
  teacher_comment TEXT NOT NULL DEFAULT '',
  student_comment TEXT NOT NULL DEFAULT '',
  text_answer TEXT NOT NULL DEFAULT '',
  needs_revision BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES student_profiles(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES student_groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'РњР°С‚РµРјР°С‚РёРєР°',
  topic TEXT NOT NULL DEFAULT '',
  start_datetime TEXT NOT NULL,
  end_datetime TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'online',
  meeting_url TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  conducted_at TEXT NOT NULL DEFAULT '',
  charged_lessons INTEGER NOT NULL DEFAULT 0,
  notification_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  related_type TEXT NOT NULL DEFAULT '',
  related_id TEXT NOT NULL DEFAULT '',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  scheduled_at TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_attachments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  related_type TEXT NOT NULL,
  related_id TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  annotation_url TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_students_teacher ON student_profiles(teacher_id);
CREATE INDEX IF NOT EXISTS idx_parent_profiles_student ON parent_profiles(student_id);
CREATE INDEX IF NOT EXISTS idx_student_groups_teacher ON student_groups(teacher_id);
CREATE INDEX IF NOT EXISTS idx_student_group_members_student ON student_group_members(student_id);
CREATE INDEX IF NOT EXISTS idx_assignments_teacher ON assignments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_assignment_recipients_student ON assignment_recipients(student_id);
CREATE INDEX IF NOT EXISTS idx_lessons_teacher ON lessons(teacher_id);
CREATE INDEX IF NOT EXISTS idx_lessons_student ON lessons(student_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_overdue_once
  ON notifications(user_id, related_type, related_id)
  WHERE related_type = 'assignment_overdue';
CREATE INDEX IF NOT EXISTS idx_file_attachments_related ON file_attachments(related_type, related_id);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def today_date():
    return datetime.now(timezone.utc).date()


def nonnegative_int(value, default: int = 0) -> int:
    try:
        return max(0, int(value if value not in (None, "") else default))
    except (TypeError, ValueError):
        return default


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or uuid.uuid4().hex
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        method, iterations, salt, digest = stored.split("$", 3)
        if method != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations))
        return hmac.compare_digest(candidate.hex(), digest)
    except ValueError:
        return False


def connect():
    if psycopg is None:
        raise RuntimeError("PostgreSQL driver is not installed. Run: pip install -r requirements.txt")
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def fetchone(conn, query: str, params: tuple = ()):
    with conn.execute(query, params) as cur:
        return cur.fetchone()


def fetchall(conn, query: str, params: tuple = ()):
    with conn.execute(query, params) as cur:
        return cur.fetchall()


def execute_schema(conn) -> None:
    for statement in SCHEMA_SQL.split(";"):
        statement = statement.strip()
        if statement:
            conn.execute(statement)


def execute_many(conn, query: str, rows: list[tuple]) -> None:
    with conn.cursor() as cur:
        cur.executemany(query, rows)


def init_db() -> None:
    with connect() as conn:
        execute_schema(conn)
        conn.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check")
        conn.execute("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('teacher', 'student', 'parent'))")
        conn.execute("ALTER TABLE assignment_recipients ADD COLUMN IF NOT EXISTS score_points INTEGER")
        conn.execute("ALTER TABLE assignment_recipients ADD COLUMN IF NOT EXISTS score_max INTEGER")
        conn.execute("ALTER TABLE file_attachments ADD COLUMN IF NOT EXISTS annotation_url TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS paid_lessons INTEGER NOT NULL DEFAULT 0")
        conn.execute("ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS lesson_price INTEGER NOT NULL DEFAULT 0")
        conn.execute("ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS meeting_url TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS student_bio TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE student_groups ADD COLUMN IF NOT EXISTS paid_lessons INTEGER NOT NULL DEFAULT 0")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS parent_profiles (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
              student_id TEXT NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
              relation TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_parent_profiles_student ON parent_profiles(student_id)")
        conn.execute("ALTER TABLE lessons ADD COLUMN IF NOT EXISTS group_id TEXT REFERENCES student_groups(id) ON DELETE CASCADE")
        conn.execute("ALTER TABLE lessons ADD COLUMN IF NOT EXISTS conducted_at TEXT NOT NULL DEFAULT ''")
        conn.execute("ALTER TABLE lessons ADD COLUMN IF NOT EXISTS charged_lessons INTEGER NOT NULL DEFAULT 0")
        conn.execute("ALTER TABLE lessons ALTER COLUMN student_id DROP NOT NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_lessons_group ON lessons(group_id)")
        conn.execute(
            """
            UPDATE lessons
            SET meeting_url = student_profiles.meeting_url
            FROM student_profiles
            WHERE lessons.student_id = student_profiles.id
              AND lessons.format = 'online'
              AND (lessons.meeting_url IS NULL OR lessons.meeting_url = '')
              AND student_profiles.meeting_url <> ''
            """
        )
        count = fetchone(conn, "SELECT COUNT(*) AS count FROM users")["count"]
        if count == 0:
            seed(conn)


def seed(conn) -> None:
    ts = now_iso()
    conn.execute(
        """
        INSERT INTO users (id, email, password_hash, role, first_name, last_name, phone, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        ("u-teacher", "kirillsaitov44@gmail.com", hash_password("Teacher123!"), "teacher", "", "", "+7 900 000-00-01", ts, ts),
    )

def user_payload(row: dict) -> dict:
    return {
        "id": row["id"],
        "email": row["email"],
        "role": row["role"],
        "firstName": row["first_name"],
        "lastName": row["last_name"],
        "phone": row["phone"],
        "avatar": row["avatar"],
        "isActive": bool(row["is_active"]),
    }


def parent_student(conn, user: dict) -> dict | None:
    if user["role"] == "student":
        return fetchone(conn, "SELECT * FROM student_profiles WHERE user_id = %s", (user["id"],))
    if user["role"] == "parent":
        return fetchone(
            conn,
            """
            SELECT student_profiles.* FROM student_profiles
            JOIN parent_profiles ON parent_profiles.student_id = student_profiles.id
            WHERE parent_profiles.user_id = %s
            """,
            (user["id"],),
        )
    return None


def parent_user_ids_for_student(conn, student_id: str) -> list[str]:
    rows = fetchall(conn, "SELECT user_id FROM parent_profiles WHERE student_id = %s", (student_id,))
    return [row["user_id"] for row in rows]


def create_student_linked_notification(conn, student_row: dict, title: str, message: str, related_type: str, related_id: str) -> None:
    create_notification(conn, student_row["user_id"], title, message, related_type, related_id)
    for parent_user_id in parent_user_ids_for_student(conn, student_row["id"]):
        create_notification(conn, parent_user_id, title, message, related_type, related_id)


def student_payload(conn, row: dict) -> dict:
    user = fetchone(conn, "SELECT * FROM users WHERE id = %s", (row["user_id"],))
    avg = fetchone(
        conn,
        """
        SELECT AVG(score_percent) AS average FROM assignment_recipients
        WHERE student_id = %s AND score_percent IS NOT NULL AND status = 'checked'
        """,
        (row["id"],),
    )["average"]
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "teacherId": row["teacher_id"],
        "grade": row["grade"],
        "notes": row["notes"],
        "bio": row["student_bio"],
        "color": row["color"],
        "paidLessons": row["paid_lessons"],
        "lessonPrice": row["lesson_price"],
        "meetingUrl": row["meeting_url"],
        "averageScore": round(avg or 0),
        "user": user_payload(user),
    }


def group_payload(conn, row: dict) -> dict:
    members = fetchall(
        conn,
        """
        SELECT student_profiles.* FROM student_profiles
        JOIN student_group_members ON student_group_members.student_id = student_profiles.id
        WHERE student_group_members.group_id = %s
        ORDER BY student_profiles.created_at
        """,
        (row["id"],),
    )
    return {
        "id": row["id"],
        "teacherId": row["teacher_id"],
        "name": row["name"],
        "description": row["description"],
        "color": row["color"],
        "paidLessons": row["paid_lessons"],
        "memberIds": [item["id"] for item in members],
        "members": [student_payload(conn, item) for item in members],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def assignment_payload(conn, row: dict, only_student_id: str | None = None) -> dict:
    if only_student_id:
        recipients = fetchall(
            conn,
            "SELECT * FROM assignment_recipients WHERE assignment_id = %s AND student_id = %s ORDER BY created_at",
            (row["id"], only_student_id),
        )
    else:
        recipients = fetchall(
            conn,
            "SELECT * FROM assignment_recipients WHERE assignment_id = %s ORDER BY created_at",
            (row["id"],),
        )
    return {
        "id": row["id"],
        "teacherId": row["teacher_id"],
        "title": row["title"],
        "description": row["description"],
        "dueDate": row["due_date"],
        "maxScore": row["max_score"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "attachments": list_attachments(conn, "assignment_material", row["id"]),
        "solutionAttachments": list_attachments(conn, "assignment_solution", row["id"]),
        "recipients": [
            {
                "id": item["id"],
                "studentId": item["student_id"],
                "status": item["status"],
                "submittedAt": item["submitted_at"],
                "checkedAt": item["checked_at"],
                "scorePercent": item["score_percent"],
                "scorePoints": item["score_points"],
                "scoreMax": item["score_max"],
                "teacherComment": item["teacher_comment"],
                "studentComment": item["student_comment"],
                "textAnswer": item["text_answer"],
                "needsRevision": bool(item["needs_revision"]),
                "attachments": list_attachments(conn, "submission", item["id"]),
            }
            for item in recipients
        ],
    }


def lesson_payload(row: dict) -> dict:
    return {
        "id": row["id"],
        "teacherId": row["teacher_id"],
        "studentId": row["student_id"],
        "groupId": row["group_id"],
        "title": row["title"],
        "topic": row["topic"],
        "start": row["start_datetime"],
        "end": row["end_datetime"],
        "format": row["format"],
        "meetingUrl": row["meeting_url"],
        "location": row["location"],
        "comment": row["comment"],
        "status": row["status"],
        "conductedAt": row["conducted_at"],
        "chargedLessons": row["charged_lessons"],
        "notify": bool(row["notification_enabled"]),
    }


def notification_payload(row: dict) -> dict:
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "type": row["type"],
        "title": row["title"],
        "message": row["message"],
        "relatedType": row["related_type"],
        "relatedId": row["related_id"],
        "isRead": bool(row["is_read"]),
        "scheduledAt": row["scheduled_at"],
        "sentAt": row["sent_at"],
        "createdAt": row["created_at"],
    }


def attachment_payload(row: dict) -> dict:
    return {
        "id": row["id"],
        "ownerId": row["owner_id"],
        "relatedType": row["related_type"],
        "relatedId": row["related_id"],
        "fileUrl": row["file_url"],
        "fileName": row["file_name"],
        "fileType": row["file_type"],
        "fileSize": row["file_size"],
        "annotationUrl": row["annotation_url"],
        "uploadedAt": row["uploaded_at"],
    }


def list_attachments(conn, related_type: str, related_id: str) -> list[dict]:
    rows = fetchall(
        conn,
        """
        SELECT * FROM file_attachments
        WHERE related_type = %s AND related_id = %s
        ORDER BY uploaded_at, file_name
        """,
        (related_type, related_id),
    )
    return [attachment_payload(row) for row in rows]


def create_attachments(conn, owner_id: str, related_type: str, related_id: str, attachments: list[dict]) -> None:
    ts = now_iso()
    for item in attachments or []:
        file_url = item.get("fileUrl", "")
        file_name = item.get("fileName", "")
        if not file_url or not file_name:
            continue
        conn.execute(
            """
            INSERT INTO file_attachments
            (id, owner_id, related_type, related_id, file_url, file_name, file_type, file_size, uploaded_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                new_id("f"),
                owner_id,
                related_type,
                related_id,
                file_url,
                file_name,
                item.get("fileType", "application/octet-stream"),
                int(item.get("fileSize") or 0),
                ts,
            ),
        )


def create_notification(conn, user_id: str, title: str, message: str, related_type: str, related_id: str) -> None:
    notification_id = new_id("n")
    conn.execute(
        """
        INSERT INTO notifications (id, user_id, type, title, message, related_type, related_id, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (notification_id, user_id, related_type, title, message, related_type, related_id, now_iso()),
    )
    send_email_notification(conn, user_id, title, message)


def create_notification_once(conn, user_id: str, title: str, message: str, related_type: str, related_id: str) -> None:
    notification_id = new_id("n")
    row = fetchone(
        conn,
        """
        INSERT INTO notifications (id, user_id, type, title, message, related_type, related_id, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING
        RETURNING id
        """,
        (notification_id, user_id, related_type, title, message, related_type, related_id, now_iso()),
    )
    if row:
        send_email_notification(conn, user_id, title, message)


def send_email_notification(conn, user_id: str, title: str, message: str) -> None:
    if not EMAIL_NOTIFICATIONS_ENABLED or not SMTP_HOST or not SMTP_FROM:
        return
    user = fetchone(conn, "SELECT email, first_name, last_name FROM users WHERE id = %s AND is_active = TRUE", (user_id,))
    if not user or not user["email"]:
        return
    recipient_name = f"{user['first_name']} {user['last_name']}".strip()
    email = EmailMessage()
    email["Subject"] = f"Study Platform: {title}"
    email["From"] = SMTP_FROM
    email["To"] = user["email"]
    greeting = f"Р—РґСЂР°РІСЃС‚РІСѓР№С‚Рµ, {recipient_name}!" if recipient_name else "Р—РґСЂР°РІСЃС‚РІСѓР№С‚Рµ!"
    email.set_content(
        "\n".join(
            [
                greeting,
                "",
                title,
                message,
                "",
                "Р­С‚Рѕ РїРёСЃСЊРјРѕ РѕС‚РїСЂР°РІР»РµРЅРѕ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РёР· Study Platform.",
            ]
        )
    )
    try:
        smtp_class = smtplib.SMTP_SSL if SMTP_USE_SSL else smtplib.SMTP
        with smtp_class(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT) as smtp:
            if SMTP_USE_TLS and not SMTP_USE_SSL:
                smtp.starttls()
            if SMTP_USER and SMTP_PASSWORD:
                smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(email)
    except Exception as exc:
        print(
            f"Email notification was not sent to {user['email']} via {SMTP_HOST}:{SMTP_PORT}: {exc}",
            file=sys.stderr,
        )


def sync_overdue_assignments(conn) -> None:
    rows = fetchall(
        conn,
        """
        SELECT
          assignment_recipients.*,
          assignments.title,
          assignments.due_date,
          assignments.teacher_id,
          users.first_name,
          users.last_name,
          users.id AS student_user_id
        FROM assignment_recipients
        JOIN assignments ON assignments.id = assignment_recipients.assignment_id
        JOIN student_profiles ON student_profiles.id = assignment_recipients.student_id
        JOIN users ON users.id = student_profiles.user_id
        WHERE assignments.due_date <> ''
          AND assignment_recipients.status IN ('assigned', 'new', 'in_progress')
        """,
    )
    today = today_date()
    ts = now_iso()
    for row in rows:
        try:
            due_date = datetime.fromisoformat(row["due_date"]).date()
        except ValueError:
            continue
        if due_date >= today:
            continue
        conn.execute(
            """
            UPDATE assignment_recipients
            SET status = 'overdue', updated_at = %s
            WHERE id = %s AND status IN ('assigned', 'new', 'in_progress')
            """,
            (ts, row["id"]),
        )
        student_name = f"{row['first_name']} {row['last_name']}"
        create_notification_once(
            conn,
            row["student_user_id"],
            "Р”РѕРјР°С€РЅРµРµ Р·Р°РґР°РЅРёРµ РїСЂРѕСЃСЂРѕС‡РµРЅРѕ",
            f"РЎСЂРѕРє СЃРґР°С‡Рё Р·Р°РґР°РЅРёСЏ \"{row['title']}\" РёСЃС‚С‘Рє {row['due_date']}. РћС‚РїСЂР°РІСЊС‚Рµ СЂРµС€РµРЅРёРµ, РєРѕРіРґР° РѕРЅРѕ Р±СѓРґРµС‚ РіРѕС‚РѕРІРѕ.",
            "assignment_overdue",
            row["id"],
        )
        for parent_user_id in parent_user_ids_for_student(conn, row["student_id"]):
            create_notification_once(
                conn,
                parent_user_id,
                "Р”РѕРјР°С€РЅРµРµ Р·Р°РґР°РЅРёРµ РїСЂРѕСЃСЂРѕС‡РµРЅРѕ",
                f"РЎСЂРѕРє СЃРґР°С‡Рё Р·Р°РґР°РЅРёСЏ \"{row['title']}\" РёСЃС‚С‘Рє {row['due_date']}.",
                "assignment_overdue",
                row["id"],
            )
        create_notification_once(
            conn,
            row["teacher_id"],
            "РџСЂРѕСЃСЂРѕС‡РµРЅРѕ РґРѕРјР°С€РЅРµРµ Р·Р°РґР°РЅРёРµ",
            f"{student_name} РЅРµ СЃРґР°Р»(Р°) Р·Р°РґР°РЅРёРµ \"{row['title']}\" РґРѕ {row['due_date']}.",
            "assignment_overdue",
            row["id"],
        )


class Handler(BaseHTTPRequestHandler):
    server_version = "StudyPlatform/0.3"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def send_json(self, data: object, status: int = HTTPStatus.OK) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw or "{}")

    def current_user(self, conn) -> dict | None:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        token = header.removeprefix("Bearer ").strip()
        return fetchone(
            conn,
            """
            SELECT users.* FROM users
            JOIN sessions ON sessions.user_id = users.id
            WHERE sessions.token = %s AND users.is_active = TRUE
            """,
            (token,),
        )

    def require_user(self, conn) -> dict | None:
        user = self.current_user(conn)
        if not user:
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "РўСЂРµР±СѓРµС‚СЃСЏ Р°РІС‚РѕСЂРёР·Р°С†РёСЏ.")
            return None
        return user

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api("GET", parsed.path)
        else:
            self.serve_static(parsed.path)

    def do_POST(self) -> None:
        self.handle_api("POST", urlparse(self.path).path)

    def do_PATCH(self) -> None:
        self.handle_api("PATCH", urlparse(self.path).path)

    def do_DELETE(self) -> None:
        self.handle_api("DELETE", urlparse(self.path).path)

    def serve_static(self, raw_path: str) -> None:
        path = unquote(raw_path)
        if path in ("", "/"):
            path = "/index.html"
        target = (ROOT / path.lstrip("/")).resolve()
        if not str(target).startswith(str(ROOT)) or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix in {".html", ".css", ".js", ".json", ".webmanifest"}:
            content_type += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def handle_api(self, method: str, path: str) -> None:
        try:
            with connect() as conn:
                if method == "POST" and path == "/api/auth/login":
                    return self.login(conn)
                if method == "POST" and path == "/api/auth/logout":
                    return self.logout(conn)
                if method == "GET" and path == "/api/auth/me":
                    user = self.require_user(conn)
                    return None if user is None else self.send_json({"user": user_payload(user)})

                user = self.require_user(conn)
                if user is None:
                    return

                if method == "GET" and path == "/api/students":
                    return self.get_students(conn, user)
                if method == "POST" and path == "/api/students":
                    return self.create_student(conn, user)
                if method == "GET" and path == "/api/profile":
                    return self.get_profile(conn, user)
                if method == "PATCH" and path == "/api/profile":
                    return self.update_profile(conn, user)
                if method == "PATCH" and path.startswith("/api/students/") and path.endswith("/paid-lessons"):
                    return self.update_paid_lessons(conn, user, "student", path.split("/")[3])
                if method == "GET" and path == "/api/groups":
                    return self.get_groups(conn, user)
                if method == "POST" and path == "/api/groups":
                    return self.create_group(conn, user)
                if method == "PATCH" and path.startswith("/api/groups/") and path.endswith("/paid-lessons"):
                    return self.update_paid_lessons(conn, user, "group", path.split("/")[3])
                if method == "GET" and path == "/api/assignments":
                    return self.get_assignments(conn, user)
                if method == "POST" and path == "/api/assignments":
                    return self.create_assignment(conn, user)
                if method == "POST" and path.endswith("/submit") and path.startswith("/api/assignments/"):
                    return self.submit_assignment(conn, user, path.split("/")[3])
                if method == "POST" and path.endswith("/check") and path.startswith("/api/assignments/"):
                    return self.check_assignment(conn, user, path.split("/")[3])
                if method == "PATCH" and path.startswith("/api/attachments/") and path.endswith("/annotation"):
                    return self.update_attachment_annotation(conn, user, path.split("/")[3])
                if method == "GET" and path == "/api/lessons":
                    return self.get_lessons(conn, user)
                if method == "POST" and path == "/api/lessons":
                    return self.create_lesson(conn, user)
                if method == "PATCH" and path.startswith("/api/lessons/") and path.endswith("/conducted"):
                    return self.update_lesson_conducted(conn, user, path.split("/")[3])
                if method == "GET" and path == "/api/notifications":
                    return self.get_notifications(conn, user)
                if method == "POST" and path == "/api/notifications/read-all":
                    return self.read_all_notifications(conn, user)
                if method == "PATCH" and path.startswith("/api/notifications/") and path.endswith("/read"):
                    return self.read_notification(conn, user, path.split("/")[3])

                self.send_error_json(HTTPStatus.NOT_FOUND, "РњР°СЂС€СЂСѓС‚ РЅРµ РЅР°Р№РґРµРЅ.")
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "РќРµРєРѕСЂСЂРµРєС‚РЅС‹Р№ JSON.")
        except DatabaseIntegrityError as exc:
            self.send_error_json(HTTPStatus.BAD_REQUEST, f"РћС€РёР±РєР° РґР°РЅРЅС‹С…: {exc}")
        except Exception as exc:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"РћС€РёР±РєР° СЃРµСЂРІРµСЂР°: {exc}")

    def login(self, conn) -> None:
        data = self.read_json()
        user = fetchone(conn, "SELECT * FROM users WHERE email = %s AND is_active = TRUE", (data.get("email", ""),))
        if not user or not verify_password(data.get("password", ""), user["password_hash"]):
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "РќРµРІРµСЂРЅС‹Р№ email РёР»Рё РїР°СЂРѕР»СЊ.")
            return
        token = uuid.uuid4().hex + uuid.uuid4().hex
        conn.execute("INSERT INTO sessions (token, user_id, created_at) VALUES (%s, %s, %s)", (token, user["id"], now_iso()))
        self.send_json({"token": token, "user": user_payload(user)})

    def logout(self, conn) -> None:
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            conn.execute("DELETE FROM sessions WHERE token = %s", (header.removeprefix("Bearer ").strip(),))
        self.send_json({"ok": True})

    def get_students(self, conn, user: dict) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РЈС‡РµРЅРёРєРё РґРѕСЃС‚СѓРїРЅС‹ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЋ.")
            return
        rows = fetchall(conn, "SELECT * FROM student_profiles WHERE teacher_id = %s ORDER BY created_at", (user["id"],))
        self.send_json({"students": [student_payload(conn, row) for row in rows]})

    def create_student(self, conn, user: dict) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РЎРѕР·РґР°РІР°С‚СЊ СѓС‡РµРЅРёРєРѕРІ РјРѕР¶РµС‚ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЊ.")
            return
        data = self.read_json()
        meeting_url = data.get("meetingUrl", "").strip()
        if not meeting_url:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Student meeting link is required.")
            return
        password = data.get("password", "").strip()
        if not password:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Student password is required.")
            return
        ts = now_iso()
        user_id = new_id("u")
        student_id = new_id("s")
        conn.execute(
            """
            INSERT INTO users (id, email, password_hash, role, first_name, last_name, phone, created_at, updated_at)
            VALUES (%s, %s, %s, 'student', %s, %s, %s, %s, %s)
            """,
            (user_id, data.get("email", ""), hash_password(password), data.get("firstName", ""), data.get("lastName", ""), data.get("phone", ""), ts, ts),
        )
        conn.execute(
            """
            INSERT INTO student_profiles (id, user_id, teacher_id, grade, notes, color, paid_lessons, lesson_price, meeting_url, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (student_id, user_id, user["id"], data.get("grade", ""), data.get("notes", ""), data.get("color", "#3B82F6"), nonnegative_int(data.get("paidLessons")), nonnegative_int(data.get("lessonPrice")), meeting_url, ts, ts),
        )
        row = fetchone(conn, "SELECT * FROM student_profiles WHERE id = %s", (student_id,))
        parent_email = data.get("parentEmail", "").strip()
        parent_password = data.get("parentPassword", "").strip()
        if parent_email and parent_password:
            parent_user_id = new_id("u")
            conn.execute(
                """
                INSERT INTO users (id, email, password_hash, role, first_name, last_name, phone, created_at, updated_at)
                VALUES (%s, %s, %s, 'parent', %s, %s, %s, %s, %s)
                """,
                (
                    parent_user_id,
                    parent_email,
                    hash_password(parent_password),
                    data.get("parentFirstName", ""),
                    data.get("parentLastName", ""),
                    data.get("parentPhone", ""),
                    ts,
                    ts,
                ),
            )
            conn.execute(
                """
                INSERT INTO parent_profiles (id, user_id, student_id, relation, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (new_id("p"), parent_user_id, student_id, data.get("parentRelation", ""), ts, ts),
            )
        self.send_json({"student": student_payload(conn, row)}, HTTPStatus.CREATED)

    def get_profile(self, conn, user: dict) -> None:
        if user["role"] not in ("student", "parent"):
            self.send_json({"user": user_payload(user), "student": None})
            return
        student = parent_student(conn, user)
        self.send_json({"user": user_payload(user), "student": student_payload(conn, student) if student else None})

    def update_profile(self, conn, user: dict) -> None:
        if user["role"] != "student":
            self.send_error_json(HTTPStatus.FORBIDDEN, "Profile editing is available only to students.")
            return
        data = self.read_json()
        avatar = data.get("avatar", "")
        if avatar and not str(avatar).startswith("data:image/"):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Avatar must be an image.")
            return
        ts = now_iso()
        conn.execute(
            """
            UPDATE users
            SET first_name = %s, last_name = %s, phone = %s, avatar = %s, updated_at = %s
            WHERE id = %s
            """,
            (
                data.get("firstName", user["first_name"]).strip(),
                data.get("lastName", user["last_name"]).strip(),
                data.get("phone", user["phone"]).strip(),
                avatar,
                ts,
                user["id"],
            ),
        )
        student = fetchone(conn, "SELECT * FROM student_profiles WHERE user_id = %s", (user["id"],))
        if student:
            conn.execute(
                "UPDATE student_profiles SET student_bio = %s, updated_at = %s WHERE id = %s",
                (data.get("bio", "").strip(), ts, student["id"]),
            )
        updated_user = fetchone(conn, "SELECT * FROM users WHERE id = %s", (user["id"],))
        updated_student = fetchone(conn, "SELECT * FROM student_profiles WHERE user_id = %s", (user["id"],))
        self.send_json({"user": user_payload(updated_user), "student": student_payload(conn, updated_student) if updated_student else None})

    def update_paid_lessons(self, conn, user: dict, target_type: str, target_id: str) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РР·РјРµРЅСЏС‚СЊ РѕРїР»Р°С‡РµРЅРЅС‹Рµ СѓСЂРѕРєРё РјРѕР¶РµС‚ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЊ.")
            return
        data = self.read_json()
        try:
            paid_lessons = max(0, int(data.get("paidLessons") or 0))
        except (TypeError, ValueError):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "РљРѕР»РёС‡РµСЃС‚РІРѕ СѓСЂРѕРєРѕРІ РґРѕР»Р¶РЅРѕ Р±С‹С‚СЊ С‡РёСЃР»РѕРј.")
            return
        ts = now_iso()
        if target_type == "student":
            row = fetchone(conn, "SELECT * FROM student_profiles WHERE id = %s AND teacher_id = %s", (target_id, user["id"]))
            if not row:
                self.send_error_json(HTTPStatus.NOT_FOUND, "РЈС‡РµРЅРёРє РЅРµ РЅР°Р№РґРµРЅ.")
                return
            lesson_price = nonnegative_int(data.get("lessonPrice"), row["lesson_price"])
            conn.execute(
                "UPDATE student_profiles SET paid_lessons = %s, lesson_price = %s, updated_at = %s WHERE id = %s",
                (paid_lessons, lesson_price, ts, target_id),
            )
            row = fetchone(conn, "SELECT * FROM student_profiles WHERE id = %s", (target_id,))
            self.send_json({"student": student_payload(conn, row)})
            return
        row = fetchone(conn, "SELECT * FROM student_groups WHERE id = %s AND teacher_id = %s", (target_id, user["id"]))
        if not row:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Р“СЂСѓРїРїР° РЅРµ РЅР°Р№РґРµРЅР°.")
            return
        conn.execute("UPDATE student_groups SET paid_lessons = %s, updated_at = %s WHERE id = %s", (paid_lessons, ts, target_id))
        row = fetchone(conn, "SELECT * FROM student_groups WHERE id = %s", (target_id,))
        self.send_json({"group": group_payload(conn, row)})

    def get_groups(self, conn, user: dict) -> None:
        if user["role"] == "teacher":
            rows = fetchall(conn, "SELECT * FROM student_groups WHERE teacher_id = %s ORDER BY created_at", (user["id"],))
        else:
            student = parent_student(conn, user)
            if not student:
                self.send_json({"groups": []})
                return
            rows = fetchall(
                conn,
                """
                SELECT student_groups.* FROM student_groups
                JOIN student_group_members ON student_group_members.group_id = student_groups.id
                WHERE student_group_members.student_id = %s
                ORDER BY student_groups.created_at
                """,
                (student["id"],),
            )
        self.send_json({"groups": [group_payload(conn, row) for row in rows]})

    def create_group(self, conn, user: dict) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РЎРѕР·РґР°РІР°С‚СЊ РіСЂСѓРїРїС‹ РјРѕР¶РµС‚ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЊ.")
            return
        data = self.read_json()
        student_ids = list(dict.fromkeys(data.get("studentIds") or []))
        if not data.get("name", "").strip():
            self.send_error_json(HTTPStatus.BAD_REQUEST, "РЈРєР°Р¶РёС‚Рµ РЅР°Р·РІР°РЅРёРµ РіСЂСѓРїРїС‹.")
            return
        if not student_ids:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Р”РѕР±Р°РІСЊС‚Рµ РІ РіСЂСѓРїРїСѓ С…РѕС‚СЏ Р±С‹ РѕРґРЅРѕРіРѕ СѓС‡РµРЅРёРєР°.")
            return
        ts = now_iso()
        group_id = new_id("g")
        conn.execute(
            """
            INSERT INTO student_groups (id, teacher_id, name, description, color, paid_lessons, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (group_id, user["id"], data.get("name", "").strip(), data.get("description", ""), data.get("color", "#1267F3"), nonnegative_int(data.get("paidLessons")), ts, ts),
        )
        for student_id in student_ids:
            student = fetchone(conn, "SELECT id FROM student_profiles WHERE id = %s AND teacher_id = %s", (student_id, user["id"]))
            if not student:
                continue
            conn.execute(
                """
                INSERT INTO student_group_members (group_id, student_id, created_at)
                VALUES (%s, %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (group_id, student_id, ts),
            )
        row = fetchone(conn, "SELECT * FROM student_groups WHERE id = %s", (group_id,))
        self.send_json({"group": group_payload(conn, row)}, HTTPStatus.CREATED)

    def get_assignments(self, conn, user: dict) -> None:
        sync_overdue_assignments(conn)
        if user["role"] == "teacher":
            rows = fetchall(conn, "SELECT * FROM assignments WHERE teacher_id = %s ORDER BY created_at DESC", (user["id"],))
            payload = [assignment_payload(conn, row) for row in rows]
        else:
            student = parent_student(conn, user)
            if not student:
                self.send_json({"assignments": []})
                return
            rows = fetchall(
                conn,
                """
                SELECT assignments.* FROM assignments
                JOIN assignment_recipients ON assignment_recipients.assignment_id = assignments.id
                WHERE assignment_recipients.student_id = %s
                ORDER BY assignments.created_at DESC
                """,
                (student["id"],),
            )
            payload = [assignment_payload(conn, row, student["id"]) for row in rows]
        self.send_json({"assignments": payload})

    def create_assignment(self, conn, user: dict) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РЎРѕР·РґР°РІР°С‚СЊ Р·Р°РґР°РЅРёСЏ РјРѕР¶РµС‚ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЊ.")
            return
        data = self.read_json()
        direct_student_ids = data.get("studentIds") or []
        group_ids = data.get("groupIds") or []
        student_ids = list(dict.fromkeys(direct_student_ids))
        for group_id in group_ids:
            group = fetchone(conn, "SELECT * FROM student_groups WHERE id = %s AND teacher_id = %s", (group_id, user["id"]))
            if not group:
                continue
            member_rows = fetchall(conn, "SELECT student_id FROM student_group_members WHERE group_id = %s", (group_id,))
            student_ids.extend(item["student_id"] for item in member_rows)
        student_ids = list(dict.fromkeys(student_ids))
        if not student_ids:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Р’С‹Р±РµСЂРёС‚Рµ С…РѕС‚СЏ Р±С‹ РѕРґРЅРѕРіРѕ СѓС‡РµРЅРёРєР° РёР»Рё РіСЂСѓРїРїСѓ.")
            return
        assignment_id = new_id("a")
        ts = now_iso()
        conn.execute(
            """
            INSERT INTO assignments (id, teacher_id, title, description, due_date, max_score, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (assignment_id, user["id"], data.get("title", ""), data.get("description", ""), data.get("dueDate", ""), int(data.get("maxScore") or 100), ts, ts),
        )
        create_attachments(conn, user["id"], "assignment_material", assignment_id, data.get("attachments") or [])
        create_attachments(conn, user["id"], "assignment_solution", assignment_id, data.get("solutionAttachments") or [])
        for student_id in student_ids:
            student = fetchone(conn, "SELECT * FROM student_profiles WHERE id = %s AND teacher_id = %s", (student_id, user["id"]))
            if not student:
                continue
            conn.execute(
                """
                INSERT INTO assignment_recipients (id, assignment_id, student_id, status, created_at, updated_at)
                VALUES (%s, %s, %s, 'new', %s, %s)
                """,
                (new_id("ar"), assignment_id, student_id, ts, ts),
            )
            create_student_linked_notification(conn, student, "РќРѕРІРѕРµ Р·Р°РґР°РЅРёРµ", f"РќР°Р·РЅР°С‡РµРЅРѕ РґРѕРјР°С€РЅРµРµ Р·Р°РґР°РЅРёРµ: {data.get('title', '')}.", "assignment", assignment_id)
        row = fetchone(conn, "SELECT * FROM assignments WHERE id = %s", (assignment_id,))
        self.send_json({"assignment": assignment_payload(conn, row)}, HTTPStatus.CREATED)

    def submit_assignment(self, conn, user: dict, assignment_id: str) -> None:
        if user["role"] != "student":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РћС‚РїСЂР°РІР»СЏС‚СЊ СЂРµС€РµРЅРёСЏ РјРѕР¶РµС‚ С‚РѕР»СЊРєРѕ СѓС‡РµРЅРёРє.")
            return
        data = self.read_json()
        student = fetchone(conn, "SELECT * FROM student_profiles WHERE user_id = %s", (user["id"],))
        recipient = fetchone(
            conn,
            "SELECT * FROM assignment_recipients WHERE assignment_id = %s AND student_id = %s",
            (assignment_id, student["id"]),
        )
        if not recipient:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Р—Р°РґР°РЅРёРµ РЅРµ РЅР°Р№РґРµРЅРѕ.")
            return
        ts = now_iso()
        conn.execute(
            """
            UPDATE assignment_recipients
            SET status = 'submitted', submitted_at = %s, text_answer = %s, student_comment = %s, updated_at = %s
            WHERE id = %s
            """,
            (ts, data.get("textAnswer", ""), data.get("studentComment", ""), ts, recipient["id"]),
        )
        create_attachments(conn, user["id"], "submission", recipient["id"], data.get("attachments") or [])
        assignment = fetchone(conn, "SELECT * FROM assignments WHERE id = %s", (assignment_id,))
        create_notification(conn, assignment["teacher_id"], "Р Р°Р±РѕС‚Р° РѕС‚РїСЂР°РІР»РµРЅР°", f"{user['first_name']} {user['last_name']} РѕС‚РїСЂР°РІРёР» СЂРµС€РµРЅРёРµ: {assignment['title']}.", "assignment", assignment_id)
        row = fetchone(conn, "SELECT * FROM assignments WHERE id = %s", (assignment_id,))
        self.send_json({"assignment": assignment_payload(conn, row, student["id"])})

    def check_assignment(self, conn, user: dict, assignment_id: str) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РџСЂРѕРІРµСЂСЏС‚СЊ Р·Р°РґР°РЅРёСЏ РјРѕР¶РµС‚ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЊ.")
            return
        data = self.read_json()
        student_id = data.get("studentId", "")
        assignment = fetchone(conn, "SELECT * FROM assignments WHERE id = %s AND teacher_id = %s", (assignment_id, user["id"]))
        recipient = fetchone(
            conn,
            "SELECT * FROM assignment_recipients WHERE assignment_id = %s AND student_id = %s",
            (assignment_id, student_id),
        )
        if not assignment or not recipient:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Р—Р°РґР°РЅРёРµ РЅРµ РЅР°Р№РґРµРЅРѕ.")
            return
        try:
            score_points = int(data.get("scorePoints") or 0)
            score_max = int(data.get("scoreMax") or assignment["max_score"] or 100)
        except (TypeError, ValueError):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "Р‘Р°Р»Р»С‹ РґРѕР»Р¶РЅС‹ Р±С‹С‚СЊ С‡РёСЃР»Р°РјРё.")
            return
        score_points = max(0, score_points)
        score_max = max(1, score_max)
        score = max(0, min(100, round(score_points / score_max * 100)))
        status = data.get("status") if data.get("status") in ("checked", "revision") else "checked"
        ts = now_iso()
        conn.execute(
            """
            UPDATE assignment_recipients
            SET status = %s, checked_at = %s, score_percent = %s, score_points = %s, score_max = %s, teacher_comment = %s, needs_revision = %s, updated_at = %s
            WHERE id = %s
            """,
            (status, ts, score, score_points, score_max, data.get("teacherComment", ""), status == "revision", ts, recipient["id"]),
        )
        student = fetchone(conn, "SELECT * FROM student_profiles WHERE id = %s", (student_id,))
        create_student_linked_notification(conn, student, "Р—Р°РґР°РЅРёРµ РїСЂРѕРІРµСЂРµРЅРѕ", f"РџСЂРѕРІРµСЂРµРЅРѕ Р·Р°РґР°РЅРёРµ \"{assignment['title']}\". Р РµР·СѓР»СЊС‚Р°С‚: {score_points}/{score_max} ({score}%).", "assignment", assignment_id)
        row = fetchone(conn, "SELECT * FROM assignments WHERE id = %s", (assignment_id,))
        self.send_json({"assignment": assignment_payload(conn, row)})

    def update_attachment_annotation(self, conn, user: dict, attachment_id: str) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РџРѕРјРµС‚РєРё РЅР° СЂРµС€РµРЅРёСЏС… РјРѕР¶РµС‚ РґРµР»Р°С‚СЊ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЊ.")
            return
        data = self.read_json()
        attachment = fetchone(conn, "SELECT * FROM file_attachments WHERE id = %s", (attachment_id,))
        if not attachment or attachment["related_type"] != "submission":
            self.send_error_json(HTTPStatus.NOT_FOUND, "Р¤Р°Р№Р» СЂРµС€РµРЅРёСЏ РЅРµ РЅР°Р№РґРµРЅ.")
            return
        recipient = fetchone(conn, "SELECT * FROM assignment_recipients WHERE id = %s", (attachment["related_id"],))
        assignment = None if not recipient else fetchone(
            conn,
            "SELECT * FROM assignments WHERE id = %s AND teacher_id = %s",
            (recipient["assignment_id"], user["id"]),
        )
        if not assignment:
            self.send_error_json(HTTPStatus.FORBIDDEN, "РќРµС‚ РґРѕСЃС‚СѓРїР° Рє СЌС‚РѕРјСѓ С„Р°Р№Р»Сѓ.")
            return
        annotation_url = data.get("annotationUrl", "")
        if annotation_url and not annotation_url.startswith("data:image/png;base64,"):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "РџРѕРјРµС‚РєРё РґРѕР»Р¶РЅС‹ Р±С‹С‚СЊ PNG-РёР·РѕР±СЂР°Р¶РµРЅРёРµРј.")
            return
        conn.execute("UPDATE file_attachments SET annotation_url = %s WHERE id = %s", (annotation_url, attachment_id))
        row = fetchone(conn, "SELECT * FROM file_attachments WHERE id = %s", (attachment_id,))
        self.send_json({"attachment": attachment_payload(row)})

    def get_lessons(self, conn, user: dict) -> None:
        if user["role"] == "teacher":
            rows = fetchall(conn, "SELECT * FROM lessons WHERE teacher_id = %s ORDER BY start_datetime", (user["id"],))
        else:
            student = parent_student(conn, user)
            if not student:
                self.send_json({"lessons": []})
                return
            rows = fetchall(
                conn,
                """
                SELECT DISTINCT lessons.* FROM lessons
                LEFT JOIN student_group_members ON student_group_members.group_id = lessons.group_id
                WHERE lessons.student_id = %s OR student_group_members.student_id = %s
                ORDER BY lessons.start_datetime
                """,
                (student["id"], student["id"]),
            )
        self.send_json({"lessons": [lesson_payload(row) for row in rows]})

    def create_lesson(self, conn, user: dict) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РЎРѕР·РґР°РІР°С‚СЊ Р·Р°РЅСЏС‚РёСЏ РјРѕР¶РµС‚ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЊ.")
            return
        data = self.read_json()
        student = None
        group = None
        if data.get("groupId"):
            group = fetchone(conn, "SELECT * FROM student_groups WHERE id = %s AND teacher_id = %s", (data.get("groupId", ""), user["id"]))
        elif data.get("studentId"):
            student = fetchone(conn, "SELECT * FROM student_profiles WHERE id = %s AND teacher_id = %s", (data.get("studentId", ""), user["id"]))
        if not student and not group:
            self.send_error_json(HTTPStatus.NOT_FOUND, "РЈС‡РµРЅРёРє РёР»Рё РіСЂСѓРїРїР° РЅРµ РЅР°Р№РґРµРЅС‹.")
            return
        lesson_format = data.get("format") or "online"
        meeting_url = data.get("meetingUrl", "").strip()
        if lesson_format == "online":
            if student:
                meeting_url = meeting_url or student["meeting_url"]
            if not meeting_url:
                self.send_error_json(HTTPStatus.BAD_REQUEST, "Online lesson needs a meeting link. Add it to the student profile or the lesson.")
                return
        ts = now_iso()
        lesson_id = new_id("l")
        conn.execute(
            """
            INSERT INTO lessons
            (id, teacher_id, student_id, group_id, title, topic, start_datetime, end_datetime, format, meeting_url, location, comment, notification_enabled, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                lesson_id,
                user["id"],
                student["id"] if student else None,
                group["id"] if group else None,
                data.get("title") or "РњР°С‚РµРјР°С‚РёРєР°",
                data.get("topic", ""),
                data.get("start", ""),
                data.get("end", ""),
                lesson_format,
                meeting_url,
                data.get("location", ""),
                data.get("comment", ""),
                bool(data.get("notify", True)),
                ts,
                ts,
            ),
        )
        if student:
            create_student_linked_notification(conn, student, "РќРѕРІРѕРµ Р·Р°РЅСЏС‚РёРµ", f"Р”РѕР±Р°РІР»РµРЅРѕ Р·Р°РЅСЏС‚РёРµ РїРѕ РјР°С‚РµРјР°С‚РёРєРµ: {data.get('start', '')}.", "lesson", lesson_id)
        if group:
            members = fetchall(
                conn,
                """
                SELECT users.id, student_profiles.id AS student_id FROM users
                JOIN student_profiles ON student_profiles.user_id = users.id
                JOIN student_group_members ON student_group_members.student_id = student_profiles.id
                WHERE student_group_members.group_id = %s
                """,
                (group["id"],),
            )
            for member in members:
                create_notification(conn, member["id"], "РќРѕРІРѕРµ РіСЂСѓРїРїРѕРІРѕРµ Р·Р°РЅСЏС‚РёРµ", f"Р”РѕР±Р°РІР»РµРЅРѕ Р·Р°РЅСЏС‚РёРµ РіСЂСѓРїРїС‹ \"{group['name']}\": {data.get('start', '')}.", "lesson", lesson_id)
                for parent_user_id in parent_user_ids_for_student(conn, member["student_id"]):
                    create_notification(conn, parent_user_id, "РќРѕРІРѕРµ РіСЂСѓРїРїРѕРІРѕРµ Р·Р°РЅСЏС‚РёРµ", f"Р”РѕР±Р°РІР»РµРЅРѕ Р·Р°РЅСЏС‚РёРµ РіСЂСѓРїРїС‹ \"{group['name']}\": {data.get('start', '')}.", "lesson", lesson_id)
        row = fetchone(conn, "SELECT * FROM lessons WHERE id = %s", (lesson_id,))
        self.send_json({"lesson": lesson_payload(row)}, HTTPStatus.CREATED)

    def update_lesson_conducted(self, conn, user: dict, lesson_id: str) -> None:
        if user["role"] != "teacher":
            self.send_error_json(HTTPStatus.FORBIDDEN, "РћС‚РјРµС‡Р°С‚СЊ Р·Р°РЅСЏС‚РёСЏ РјРѕР¶РµС‚ С‚РѕР»СЊРєРѕ СѓС‡РёС‚РµР»СЊ.")
            return
        data = self.read_json()
        conducted = bool(data.get("conducted"))
        lesson = fetchone(conn, "SELECT * FROM lessons WHERE id = %s AND teacher_id = %s", (lesson_id, user["id"]))
        if not lesson:
            self.send_error_json(HTTPStatus.NOT_FOUND, "Р—Р°РЅСЏС‚РёРµ РЅРµ РЅР°Р№РґРµРЅРѕ.")
            return

        already_conducted = bool(lesson["conducted_at"])
        charged_lessons = int(lesson["charged_lessons"] or 0)
        if conducted and not already_conducted:
            charged = 0
            if lesson["student_id"]:
                student = fetchone(conn, "SELECT paid_lessons FROM student_profiles WHERE id = %s AND teacher_id = %s", (lesson["student_id"], user["id"]))
                if student and int(student["paid_lessons"] or 0) > 0:
                    conn.execute("UPDATE student_profiles SET paid_lessons = paid_lessons - 1, updated_at = %s WHERE id = %s", (now_iso(), lesson["student_id"]))
                    charged = 1
            elif lesson["group_id"]:
                group = fetchone(conn, "SELECT paid_lessons FROM student_groups WHERE id = %s AND teacher_id = %s", (lesson["group_id"], user["id"]))
                if group and int(group["paid_lessons"] or 0) > 0:
                    conn.execute("UPDATE student_groups SET paid_lessons = paid_lessons - 1, updated_at = %s WHERE id = %s", (now_iso(), lesson["group_id"]))
                    charged = 1
            conn.execute(
                "UPDATE lessons SET conducted_at = %s, charged_lessons = %s, status = 'conducted', updated_at = %s WHERE id = %s",
                (now_iso(), charged, now_iso(), lesson_id),
            )
        elif not conducted and already_conducted:
            if charged_lessons > 0 and lesson["student_id"]:
                conn.execute("UPDATE student_profiles SET paid_lessons = paid_lessons + %s, updated_at = %s WHERE id = %s", (charged_lessons, now_iso(), lesson["student_id"]))
            elif charged_lessons > 0 and lesson["group_id"]:
                conn.execute("UPDATE student_groups SET paid_lessons = paid_lessons + %s, updated_at = %s WHERE id = %s", (charged_lessons, now_iso(), lesson["group_id"]))
            conn.execute(
                "UPDATE lessons SET conducted_at = '', charged_lessons = 0, status = 'planned', updated_at = %s WHERE id = %s",
                (now_iso(), lesson_id),
            )

        row = fetchone(conn, "SELECT * FROM lessons WHERE id = %s", (lesson_id,))
        self.send_json({"lesson": lesson_payload(row)})

    def get_notifications(self, conn, user: dict) -> None:
        sync_overdue_assignments(conn)
        rows = fetchall(conn, "SELECT * FROM notifications WHERE user_id = %s ORDER BY created_at DESC", (user["id"],))
        self.send_json({"notifications": [notification_payload(row) for row in rows]})

    def read_all_notifications(self, conn, user: dict) -> None:
        conn.execute("UPDATE notifications SET is_read = TRUE WHERE user_id = %s", (user["id"],))
        self.send_json({"ok": True})

    def read_notification(self, conn, user: dict, notification_id: str) -> None:
        conn.execute("UPDATE notifications SET is_read = TRUE WHERE id = %s AND user_id = %s", (notification_id, user["id"]))
        self.send_json({"ok": True})


def main() -> None:
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Study Platform running at http://{HOST}:{PORT}")
    print(f"PostgreSQL database: {DATABASE_URL}")
    server.serve_forever()


if __name__ == "__main__":
    main()
