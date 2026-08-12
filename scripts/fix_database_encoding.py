from __future__ import annotations

import os
from pathlib import Path

import psycopg


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"


def load_env() -> None:
    if not ENV_PATH.exists():
        return
    for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def fix_mojibake(value: str) -> str:
    if not value:
        return value
    try:
        fixed = value.encode("cp1251").decode("utf-8")
    except UnicodeError:
        return value
    return fixed if fixed != value else value


TEXT_COLUMNS = {
    "users": ["first_name", "last_name", "phone", "avatar"],
    "student_profiles": ["grade", "notes", "meeting_url"],
    "parent_profiles": ["relation"],
    "student_groups": ["name", "description", "meeting_url"],
    "assignments": ["title", "description", "due_date", "teacher_comment"],
    "assignment_recipients": ["text_answer", "student_comment", "teacher_comment"],
    "lessons": ["topic", "start_datetime", "end_datetime", "meeting_url", "location", "comment", "status"],
    "notifications": ["type", "title", "message", "related_type", "scheduled_at", "sent_at"],
    "file_attachments": ["file_url", "file_name", "file_type", "annotation_url"],
}


def main() -> None:
    load_env()
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set.")

    total = 0
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            for table, columns in TEXT_COLUMNS.items():
                cur.execute(f"SELECT id, {', '.join(columns)} FROM {table}")
                rows = cur.fetchall()
                for row in rows:
                    row_id = row[0]
                    updates = {}
                    for column, value in zip(columns, row[1:]):
                        if isinstance(value, str):
                            fixed = fix_mojibake(value)
                            if fixed != value:
                                updates[column] = fixed
                    if not updates:
                        continue
                    assignments = ", ".join(f"{column} = %s" for column in updates)
                    params = list(updates.values()) + [row_id]
                    cur.execute(f"UPDATE {table} SET {assignments} WHERE id = %s", params)
                    total += len(updates)
        conn.commit()

    print(f"Fixed text fields: {total}")


if __name__ == "__main__":
    main()
