"""IGNITE: school details on a batch, correcting a sheet, Submit, skills and hands-on scores."""
import csv
import io

import pytest

from server.ignite import skill_scores

from .conftest import ADMIN, TEACHER, make_app
from .test_api import make_batch, make_state, make_test, upload

DETAILS = {"district": "Nashik", "block": "Dindori", "school": "ZP School Ramnagar", "grade": "7",
           "assessed_on": "2026-11-02"}


@pytest.fixture()
def app(tmp_path):
    return make_app(tmp_path, IGNITE_ENABLED=True)


@pytest.fixture()
def teacher(client):
    """A teacher an admin has approved."""
    client.get("/api/me", headers=TEACHER)
    user = next(u for u in client.get("/api/users", headers=ADMIN).json if u["email"] == "teacher@example.org")
    client.patch(f"/api/users/{user['id']}", json={"status": "approved"}, headers=ADMIN)
    return TEACHER


def patch_sheet(client, sheet, headers=ADMIN, **body):
    return client.patch(f"/api/sheets/{sheet['id']}", json=body, headers=headers)


def blank_page():
    import cv2
    import numpy as np
    return io.BytesIO(cv2.imencode(".jpg", np.full((800, 600), 255, np.uint8))[1].tobytes())


def upload_unreadable(client, batch_id):
    r = client.post(f"/api/batches/{batch_id}/sheets", headers=ADMIN, content_type="multipart/form-data",
                    data={"file": (blank_page(), "blank.jpg"), "source_name": "blank.jpg"})
    assert r.status_code == 201 and r.json[0]["status"] == "error"
    return r.json[0]


# ---- the switch --------------------------------------------------------------------------

def test_switched_off_nothing_new_answers(tmp_path):
    """Without IGNITE_ENABLED the new routes are not there and a batch takes no school details."""
    client = make_app(tmp_path).test_client()
    assert client.get("/api/me", headers=ADMIN).json["features"] == {"ignite": False}
    t = make_test(client)
    state = make_state(client)
    r = client.post("/api/batches", headers=ADMIN,
                    json={"test_id": t["id"], "state_id": state["id"], "name": "Class 7A", **DETAILS})
    assert r.status_code == 201 and r.json["district"] == "" and r.json["assessed_on"] is None
    s = upload(client, r.json["id"], "filled_sheet.jpg")[0]
    assert client.patch(f"/api/sheets/{s['id']}", json={"confirm": True}, headers=ADMIN).status_code == 404
    assert client.patch(f"/api/batches/{r.json['id']}", json=DETAILS, headers=ADMIN).status_code == 404
    assert client.post(f"/api/batches/{r.json['id']}/submit", headers=ADMIN).status_code == 404
    assert client.post(f"/api/batches/{r.json['id']}/reopen", headers=ADMIN).status_code == 404
    assert client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 5}, headers=ADMIN).status_code == 404
    assert client.get("/api/places", headers=ADMIN).status_code == 404


def test_new_routes_need_sign_in(client):
    assert client.patch("/api/sheets/x", json={}).status_code == 401
    assert client.post("/api/batches/x/submit").status_code == 401
    assert client.get("/api/places").status_code == 401


# ---- school details ----------------------------------------------------------------------

def test_a_batch_carries_its_school_details(client):
    assert client.get("/api/me", headers=ADMIN).json["features"] == {"ignite": True}
    t = make_test(client)
    state = make_state(client)
    body = {"test_id": t["id"], "state_id": state["id"], "name": "Ramnagar 7", **DETAILS,
            "school": "  ZP  School Ramnagar "}
    b = client.post("/api/batches", json=body, headers=ADMIN).json
    assert {k: b[k] for k in DETAILS} == DETAILS            # spaces tidied
    # More sheets for the same batch, with the block left empty and a grade typed: nothing is wiped.
    again = client.post("/api/batches", json={**body, "block": "", "grade": "8"}, headers=ADMIN)
    assert again.status_code == 200 and again.json["block"] == "Dindori" and again.json["grade"] == "8"

    r = client.patch(f"/api/batches/{b['id']}", json={"school": "ZP School Ramnagar No. 2", "block": ""}, headers=ADMIN)
    assert r.status_code == 200 and r.json["school"] == "ZP School Ramnagar No. 2" and r.json["block"] == ""
    assert client.patch(f"/api/batches/{b['id']}", json={"assessed_on": "2 Nov"}, headers=ADMIN).status_code == 400
    assert client.patch(f"/api/batches/{b['id']}", json={"assessed_on": "2999-01-01"}, headers=ADMIN).status_code == 400

    places = client.get("/api/places", headers=ADMIN).json
    assert places["places"] == [{"state_id": state["id"], "district": "Nashik", "block": "",
                                 "school": "ZP School Ramnagar No. 2", "status": ""}]
    assert places["grades"] == ["8"]


def test_only_an_admin_sets_students_reached(client, teacher):
    b = make_batch(client, make_test(client)["id"])
    r = client.patch(f"/api/batches/{b['id']}", json={"students_reached": 60}, headers=teacher)
    assert r.status_code == 403
    r = client.patch(f"/api/batches/{b['id']}", json={"students_reached": 60}, headers=ADMIN)
    assert r.status_code == 200 and r.json["students_reached"] == 60
    assert client.patch(f"/api/batches/{b['id']}", json={"students_reached": 2.5}, headers=ADMIN).status_code == 400


def test_with_an_activity_score_submit_waits_for_the_scores_and_the_students(client, teacher):
    """The team's answers 1 and 10: everyone does the hands-on challenge, only those who pass it
    write the test. So every paper has an activity score, and the teacher types how many students
    did the challenge, from the attendance: never fewer than the papers."""
    t = make_test(client)
    client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 5}, headers=ADMIN)
    b = make_batch(client, t["id"])
    client.patch(f"/api/batches/{b['id']}", json=DETAILS, headers=ADMIN)
    s = upload(client, b["id"], "filled_sheet.jpg")[0]
    patch_sheet(client, s, confirm=True)

    r = client.post(f"/api/batches/{b['id']}/submit", headers=ADMIN)
    assert r.status_code == 400 and r.json["error"] == "1 paper has no activity score yet. Type it first."
    patch_sheet(client, s, hands_on_score=4)
    r = client.post(f"/api/batches/{b['id']}/submit", headers=ADMIN)
    assert r.status_code == 400 and "how many students did the hands-on challenge" in r.json["error"]

    # Here the teacher types it, not only an admin; fewer than the papers is refused.
    r = client.patch(f"/api/batches/{b['id']}", json={"students_reached": 0}, headers=teacher)
    assert r.status_code == 400 and "fewer than the papers (1)" in r.json["error"]
    r = client.patch(f"/api/batches/{b['id']}", json={"students_reached": 3}, headers=teacher)
    assert r.status_code == 200 and r.json["students_reached"] == 3

    # A second paper arrives after the count was typed: still at least as many as the papers.
    s2 = upload(client, b["id"], "filled_sheet.jpg")[0]
    patch_sheet(client, s2, confirm=True, hands_on_score=2)
    assert client.patch(f"/api/batches/{b['id']}", json={"students_reached": 1}, headers=ADMIN).status_code == 400
    r = client.post(f"/api/batches/{b['id']}/submit", headers=ADMIN)
    assert r.status_code == 200 and r.json["submitted_at"]


def test_without_an_activity_score_submit_asks_for_neither(client):
    b = make_batch(client, make_test(client)["id"])
    client.patch(f"/api/batches/{b['id']}", json=DETAILS, headers=ADMIN)
    patch_sheet(client, upload(client, b["id"], "filled_sheet.jpg")[0], confirm=True)
    assert client.post(f"/api/batches/{b['id']}/submit", headers=ADMIN).status_code == 200


# ---- correcting a sheet ------------------------------------------------------------------

def test_correcting_an_answer_rescores_and_keeps_the_first_reading(client, teacher):
    t = make_test(client)
    b = make_batch(client, t["id"])
    s = upload(client, b["id"], "double_marked.jpg")[0]
    assert s["answers"]["q15"] == "CD" and s["score"] == 38 and s["needs_review"] is True

    right = t["answer_key"]["q15"]
    r = patch_sheet(client, s, teacher, answers={"q15": right}, fields={"Name": "  asha   patil "}, confirm=True)
    assert r.status_code == 200, r.json
    fixed = r.json
    assert fixed["answers"]["q15"] == right and fixed["score"] == 39
    assert fixed["fields"]["Name"] == "asha patil"
    assert fixed["needs_review"] is False and fixed["review_reason"] == ""
    assert fixed["confirmed_by"] == "teacher@example.org"
    # The first reading is kept as it was, and the change says who made it.
    assert fixed["original"]["answers"]["q15"] == "CD" and fixed["original"]["score"] == 38
    assert fixed["original"]["needs_review"] is True and "q15" in fixed["original"]["review_reason"]
    entry = fixed["changes"][-1]
    assert entry["by"] == "teacher@example.org"
    assert {"what": "q15", "from": "CD", "to": right} in entry["changes"]
    assert any(c["what"] == "Checked" for c in entry["changes"])
    # The batch no longer has a sheet to check, and the list gives the corrected sheet.
    assert client.get(f"/api/batches/{b['id']}", headers=ADMIN).json["review_count"] == 0
    assert client.get(f"/api/batches/{b['id']}/sheets", headers=ADMIN).json[0]["score"] == 39

    # A second correction keeps the very first reading, not the one before it.
    again = patch_sheet(client, s, answers={"q15": ""}).json
    assert again["score"] == 38 and again["original"]["answers"]["q15"] == "CD" and len(again["changes"]) == 2
    # Putting the first reading back brings the flag back too.
    back = patch_sheet(client, s, restore=True).json
    assert back["answers"]["q15"] == "CD" and back["score"] == 38 and back["needs_review"] is True
    assert "original" not in back and back["confirmed_by"] == ""
    assert patch_sheet(client, s, restore=True).status_code == 400


def test_marks_scheme_is_used_when_rescoring(client):
    t = make_test(client, marks_correct=4, marks_incorrect=-1)
    s = upload(client, make_batch(client, t["id"])["id"], "filled_sheet.jpg")[0]
    assert s["score"] == 44 * 4 - 6
    wrong = next(q for q, a in s["answers"].items() if a and a != t["answer_key"][q])
    assert patch_sheet(client, s, answers={wrong: t["answer_key"][wrong]}).json["score"] == 45 * 4 - 5


def test_what_is_typed_on_a_sheet_is_checked(client):
    t = make_test(client)
    s = upload(client, make_batch(client, t["id"])["id"], "filled_sheet.jpg")[0]
    assert patch_sheet(client, s, answers={"q1": "Z"}).status_code == 400
    assert patch_sheet(client, s, answers={"q1": "AB"}).status_code == 400
    assert patch_sheet(client, s, answers={"q99": "A"}).status_code == 400
    assert patch_sheet(client, s, fields={"School": "x"}).status_code == 400
    assert patch_sheet(client, s, fields={"gender": "other"}).status_code == 400
    assert patch_sheet(client, s, fields={"Mobile Number": "98765abc"}).status_code == 400
    assert patch_sheet(client, s, hands_on_score=3).status_code == 400      # this key takes none
    r = patch_sheet(client, s, fields={"gender": "male", "Mobile Number": "98765 00011"}, answers={"q1": "b"})
    assert r.status_code == 200
    assert r.json["fields"]["gender"] == "Male" and r.json["fields"]["Mobile Number"] == "9876500011"
    assert r.json["answers"]["q1"] == "B"
    # Nothing changed, nothing recorded.
    same = patch_sheet(client, s, fields={"gender": "Male"}).json
    assert len(same["changes"]) == 1


def test_an_unreadable_sheet_is_typed_in_by_hand_or_left_out(client):
    t = make_test(client)
    b = make_batch(client, t["id"])
    s = upload_unreadable(client, b["id"])
    assert patch_sheet(client, s, confirm=True).status_code == 400

    key = t["answer_key"]
    typed = {q: key[q] for q in list(key)[:30]}
    r = patch_sheet(client, s, fields={"Name": "RAVI KALE", "Roll Number": "07", "gender": "Male"}, answers=typed)
    assert r.status_code == 200, r.json
    done = r.json
    assert done["status"] == "ok" and done["entered_by_hand"] is True and done["score"] == 30
    assert done["needs_review"] is False and done["error_reason"] == ""
    assert done["fields"] == {"Mobile Number": "", "Name": "RAVI KALE", "Roll Number": "07", "gender": "Male"}
    assert done["answers"]["q50"] == "" and len(done["answers"]) == 50
    assert done["original"]["status"] == "error" and "corner targets" in done["original"]["error_reason"]
    counts = client.get(f"/api/batches/{b['id']}", headers=ADMIN).json
    assert (counts["sheet_count"], counts["read_count"], counts["error_count"]) == (1, 1, 0)

    other = upload_unreadable(client, b["id"])
    assert patch_sheet(client, other, left_out=True).json["left_out"] is True
    counts = client.get(f"/api/batches/{b['id']}", headers=ADMIN).json
    assert (counts["sheet_count"], counts["error_count"], counts["left_out_count"]) == (1, 0, 1)


# ---- skills and hands-on ------------------------------------------------------------------

def test_skill_scores_follow_the_map():
    key = {"q1": "A", "q2": "B", "q3": "C", "q4": "D"}
    skills = {"q1": "Logic", "q2": "Data", "q3": "Logic"}           # q4 has no skill
    answers = {"q1": "A", "q2": "C", "q3": "", "q4": "D"}
    assert skill_scores(answers, key, skills) == [{"skill": "Logic", "correct": 1, "total": 2},
                                                  {"skill": "Data", "correct": 0, "total": 1}]
    assert skill_scores(answers, key, {}) == []
    # A question that needs two bubbles, and one where either of two is right.
    assert skill_scores({"q1": "BC", "q2": "C"}, {"q1": "BC", "q2": "B/C"}, {"q1": "Logic", "q2": "Logic"}) == [
        {"skill": "Logic", "correct": 2, "total": 2}]


def test_a_teacher_types_two_letters_only_where_the_key_asks_for_two(client):
    from .conftest import key_dict
    t = make_test(client, answer_key={**key_dict(), "q2": "BC"})
    s = upload(client, make_batch(client, t["id"])["id"], "filled_sheet.jpg")[0]
    assert patch_sheet(client, s, answers={"q1": "AB"}).status_code == 400     # question 1 has one answer
    assert patch_sheet(client, s, answers={"q2": "BB"}).status_code == 400
    assert s["score"] == 43                    # one filled bubble is not enough for question 2 (44 with the usual key)
    r = patch_sheet(client, s, answers={"q2": "CB"})
    assert r.status_code == 200 and r.json["answers"]["q2"] == "BC" and r.json["score"] == 44


def test_admin_sets_skills_and_hands_on_for_an_answer_key(client, teacher):
    t = make_test(client)
    skills = {f"q{i}": "Logic" if i <= 25 else "  Data &  Experiments " for i in range(1, 51)}
    assert client.put(f"/api/tests/{t['id']}/ignite", json={"skill_map": skills}, headers=teacher).status_code == 403
    r = client.put(f"/api/tests/{t['id']}/ignite", json={"skill_map": skills, "hands_on_max": 5}, headers=ADMIN)
    assert r.status_code == 200 and r.json["hands_on_max"] == 5
    assert r.json["skill_map"]["q1"] == "Logic" and r.json["skill_map"]["q50"] == "Data & Experiments"
    assert client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 0}, headers=ADMIN).status_code == 400
    # Saving the answer key again leaves the skills as they are.
    r = client.put(f"/api/tests/{t['id']}", json={"name": "Endline Nov"}, headers=ADMIN)
    assert r.status_code == 200 and r.json["skill_map"]["q1"] == "Logic" and r.json["hands_on_max"] == 5
    # The pass mark of the hands-on challenge: 3 of 5 (the call on 25 November).
    assert r.json["hands_on_pass"] is None
    for wrong in (0, 6, "lots"):
        assert client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_pass": wrong}, headers=ADMIN).status_code == 400
    r = client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_pass": 3}, headers=ADMIN)
    assert r.status_code == 200 and r.json["hands_on_pass"] == 3 and r.json["hands_on_max"] == 5
    # A new maximum below the pass mark takes the pass mark away; both can be set at once.
    assert client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 2}, headers=ADMIN).json["hands_on_pass"] is None
    r = client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 15, "hands_on_pass": 9}, headers=ADMIN)
    assert r.json["hands_on_max"] == 15 and r.json["hands_on_pass"] == 9
    r = client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 5, "hands_on_pass": 3}, headers=ADMIN)
    assert r.json["hands_on_max"] == 5 and r.json["hands_on_pass"] == 3

    b = make_batch(client, t["id"])
    s = upload(client, b["id"], "filled_sheet.jpg")[0]
    listed = client.get(f"/api/batches/{b['id']}/sheets", headers=ADMIN).json[0]
    by_skill = {row["skill"]: row for row in listed["skills"]}
    assert set(by_skill) == {"Logic", "Data & Experiments"}
    assert by_skill["Logic"]["total"] == 25 and by_skill["Data & Experiments"]["total"] == 25
    assert by_skill["Logic"]["correct"] + by_skill["Data & Experiments"]["correct"] == 44

    assert patch_sheet(client, s, teacher, hands_on_score=6).status_code == 400
    assert patch_sheet(client, s, teacher, hands_on_score="lots").status_code == 400
    r = patch_sheet(client, s, teacher, hands_on_score=4.5)
    assert r.status_code == 200 and r.json["hands_on_score"] == 4.5
    assert "original" not in r.json            # the reading itself did not change
    assert r.json["changes"][-1]["changes"] == [{"what": "Hands-on score", "from": None, "to": 4.5}]
    assert client.get(f"/api/batches/{b['id']}", headers=ADMIN).json["hands_on_count"] == 1
    assert patch_sheet(client, s, teacher, hands_on_score=None).json["hands_on_score"] is None
    # No hands-on for this key any more, and no skills.
    r = client.put(f"/api/tests/{t['id']}/ignite", json={"skill_map": {}, "hands_on_max": None}, headers=ADMIN)
    assert r.json["skill_map"] == {} and r.json["hands_on_max"] is None and r.json["hands_on_pass"] is None
    assert client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_pass": 3}, headers=ADMIN).status_code == 400


# ---- submit ------------------------------------------------------------------------------

def test_a_batch_is_submitted_only_when_every_sheet_is_settled(client, teacher):
    t = make_test(client)
    state = make_state(client)
    b = client.post("/api/batches", headers=teacher,
                    json={"test_id": t["id"], "state_id": state["id"], "name": "Ramnagar 7"}).json
    submit = lambda who=teacher: client.post(f"/api/batches/{b['id']}/submit", headers=who)   # noqa: E731
    assert "no sheets" in submit().json["error"]

    upload(client, b["id"], "filled_sheet.jpg", headers=teacher)
    flagged = upload(client, b["id"], "double_marked.jpg", headers=teacher)[0]
    unread = upload_unreadable(client, b["id"])
    r = submit()
    assert r.status_code == 400
    assert "1 sheet still needs a check and 1 sheet could not be read" in r.json["error"]

    patch_sheet(client, flagged, teacher, confirm=True)
    patch_sheet(client, unread, teacher, left_out=True)
    r = submit()
    assert r.status_code == 400 and "district and the block and the school" in r.json["error"]
    # The fellows type the school (the call on 25 November): Submit waits for it too.
    client.patch(f"/api/batches/{b['id']}", json={**DETAILS, "school": ""}, headers=teacher)
    r = submit()
    assert r.status_code == 400 and r.json["error"] == "add the school of this batch first"
    client.patch(f"/api/batches/{b['id']}", json=DETAILS, headers=teacher)

    r = submit()
    assert r.status_code == 200 and r.json["submitted_by"] == "teacher@example.org" and r.json["submitted_at"]
    assert submit().json["submitted_at"] == r.json["submitted_at"]          # a second press changes nothing

    # Submitted: the teacher can change nothing more, and no sheet is added.
    assert patch_sheet(client, flagged, teacher, answers={"q1": "A"}).status_code == 403
    assert client.patch(f"/api/batches/{b['id']}", json={"school": "x"}, headers=teacher).status_code == 403
    r = client.post(f"/api/batches/{b['id']}/sheets", headers=teacher, content_type="multipart/form-data",
                    data={"file": (blank_page(), "late.jpg")})
    assert r.status_code == 400 and "submitted" in r.json["error"]
    # The admin still can, and can send it back.
    assert patch_sheet(client, flagged, ADMIN, answers={"q1": "A"}).status_code == 200
    assert client.post(f"/api/batches/{b['id']}/reopen", headers=teacher).status_code == 403
    r = client.post(f"/api/batches/{b['id']}/reopen", headers=ADMIN)
    assert r.status_code == 200 and r.json["submitted_at"] is None and r.json["submitted_by"] == ""
    assert patch_sheet(client, flagged, teacher, answers={"q1": "B"}).status_code == 200


# ---- the Excel download -------------------------------------------------------------------

def test_download_carries_the_details_and_skips_sheets_left_out(client):
    t = make_test(client)
    client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 5}, headers=ADMIN)
    state = make_state(client)
    b = client.post("/api/batches", headers=ADMIN,
                    json={"test_id": t["id"], "state_id": state["id"], "name": "Ramnagar 7", **DETAILS}).json
    kept = upload(client, b["id"], "filled_sheet.jpg")[0]
    patch_sheet(client, kept, hands_on_score=4)
    patch_sheet(client, upload_unreadable(client, b["id"]), left_out=True)

    text = client.get(f"/api/batches/{b['id']}/results.csv", headers=ADMIN).data.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    assert len(rows) == 1
    row = rows[0]
    assert (row["District"], row["Block"], row["School Name"], row["Grade"]) == ("Nashik", "Dindori", "ZP School Ramnagar", "7")
    assert row["Date of assessment"] == "2026-11-02" and row["Hand-on Activity Score"] == "4"
    assert client.get(f"/api/batches/{b['id']}/results.xlsx", headers=ADMIN).status_code == 200
