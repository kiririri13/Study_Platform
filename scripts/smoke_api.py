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


def main() -> None:
    teacher_status, teacher_login = request(
        "/api/auth/login",
        "POST",
        payload={"email": "teacher@example.com", "password": "Teacher123!"},
    )
    assert teacher_status == 200, teacher_login
    assert teacher_login["user"]["role"] == "teacher"

    students_status, students = request("/api/students", token=teacher_login["token"])
    assert students_status == 200, students
    assert len(students["students"]) >= 2

    student_status, student_login = request(
        "/api/auth/login",
        "POST",
        payload={"email": "student1@example.com", "password": "Student123!"},
    )
    assert student_status == 200, student_login
    assert student_login["user"]["role"] == "student"

    assignments_status, assignments = request("/api/assignments", token=student_login["token"])
    assert assignments_status == 200, assignments
    assert all(len(item["recipients"]) == 1 for item in assignments["assignments"])

    forbidden_status, forbidden = request("/api/students", token=student_login["token"])
    assert forbidden_status == 403, forbidden

    print(
        json.dumps(
            {
                "teacherLogin": True,
                "studentCount": len(students["students"]),
                "studentLogin": True,
                "studentAssignments": len(assignments["assignments"]),
                "studentCannotListAllStudents": True,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
