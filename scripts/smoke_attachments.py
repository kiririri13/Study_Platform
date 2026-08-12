from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request


BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"


def request(path: str, method: str = "GET", token: str | None = None, payload: dict | None = None) -> tuple[int, dict]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{BASE_URL}{path}", data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def fake_image(name: str) -> dict:
    data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
    return {
        "fileName": name,
        "fileType": "image/png",
        "fileSize": len(data),
        "fileUrl": f"data:image/png;base64,{data}",
    }


def main() -> None:
    teacher_status, teacher_login = request(
        "/api/auth/login",
        "POST",
        payload={"email": "teacher@example.com", "password": "Teacher123!"},
    )
    assert teacher_status == 200, teacher_login

    students_status, students = request("/api/students", token=teacher_login["token"])
    assert students_status == 200, students
    student_id = students["students"][0]["id"]

    create_status, created = request(
        "/api/assignments",
        "POST",
        token=teacher_login["token"],
        payload={
            "title": "Тест с фото",
            "description": "Проверка вложений.",
            "dueDate": "2026-07-10",
            "maxScore": 100,
            "studentIds": [student_id],
            "attachments": [fake_image("condition.png")],
            "solutionAttachments": [fake_image("teacher-solution.png")],
        },
    )
    assert create_status == 201, created
    assignment = created["assignment"]
    assert len(assignment["attachments"]) == 1
    assert len(assignment["solutionAttachments"]) == 1

    student_status, student_login = request(
        "/api/auth/login",
        "POST",
        payload={"email": students["students"][0]["user"]["email"], "password": "Student123!"},
    )
    assert student_status == 200, student_login

    submit_status, submitted = request(
        f"/api/assignments/{assignment['id']}/submit",
        "POST",
        token=student_login["token"],
        payload={
            "textAnswer": "Решение приложено фотографией.",
            "studentComment": "Фото решения",
            "attachments": [fake_image("student-solution.png")],
        },
    )
    assert submit_status == 200, submitted
    assert len(submitted["assignment"]["recipients"][0]["attachments"]) == 1

    print(json.dumps({"assignmentPhoto": True, "teacherSolution": True, "studentPhoto": True}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
