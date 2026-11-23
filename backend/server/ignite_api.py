"""The IGNITE routes: school details of a batch, correcting a sheet, Submit, and the skills and
hands-on settings of an answer key. Every one answers 404 unless IGNITE_ENABLED is set."""
from __future__ import annotations

import json
from functools import wraps

from flask import abort, g, jsonify, request
from sqlalchemy.orm import selectinload

from omr import needs_all, score_answers
from .api import _BATCH_COUNTS, api, db, engine, now
from .auth import require_admin, require_user
from .ignite import clean_text, ignite_on, set_details, sheet_dict
from .ignite_feed import key, place_key
from .models import Batch, IgniteBlock, IgniteDistrict, Sheet, State, Test, iso

# What may be typed for each detail on a sheet.
FIELD_LIMITS = {"Name": 60, "Roll Number": 20, "Mobile Number": 15}
GENDERS = {"male": "Male", "female": "Female"}   # the two bubbles on the sheet


def ignite_only(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not ignite_on():
            abort(404)
        return fn(*a, **kw)
    return wrapper


def _number(value, what: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        abort(400, f"{what} must be a number")


def _open_for_changes(b: Batch) -> None:
    """A submitted batch is with the admin: only an admin changes it."""
    if b.submitted_at and g.user.role != "admin":
        abort(403, "this batch was submitted. An admin can open it again.")


# ---- an answer key's skills and hands-on score ---------------------------------------

@api.put("/tests/<test_id>/ignite")
@require_admin
@ignite_only
def set_test_ignite(test_id):
    """skill_map says which skill each question tests ({"q1": "Scientific Reasoning", ...});
    hands_on_max is the most a student can score in the hands-on activity, or null when this
    answer key has no hands-on score."""
    t = db().get(Test, test_id) or abort(404)
    body = request.get_json(force=True) or {}
    if "skill_map" in body:
        raw = body["skill_map"] or {}
        if not isinstance(raw, dict):
            abort(400, "skill_map must give a skill for each question")
        clean = {}
        for i in range(1, t.question_count + 1):
            if skill := clean_text(raw.get(f"q{i}"), 80):
                clean[f"q{i}"] = skill
        t.skill_map_json = json.dumps(clean) if clean else None
    if "hands_on_max" in body:
        if body["hands_on_max"] in (None, ""):
            t.hands_on_max = None
        else:
            most = _number(body["hands_on_max"], "the hands-on maximum")
            if not 0 < most <= 1000:
                abort(400, "the hands-on maximum must be more than 0")
            t.hands_on_max = most
    db().commit()
    return jsonify(t.to_dict())


# ---- the school details of a batch -------------------------------------------------------

@api.patch("/batches/<batch_id>")
@require_user
@ignite_only
def update_batch_details(batch_id):
    b = db().get(Batch, batch_id, options=_BATCH_COUNTS) or abort(404)
    _open_for_changes(b)
    body = request.get_json(force=True) or {}
    set_details(b, body)
    if "students_reached" in body:
        # With an activity score on the answer key, the teacher types how many students did the
        # hands-on challenge, from the attendance: everyone does it, and only those who pass it
        # write the test (answers 1 and 10). Without one, it is an admin's own figure.
        if g.user.role != "admin" and not b.test.hands_on_max:
            abort(403, "only an admin sets the number of students reached")
        if body["students_reached"] in (None, ""):
            b.students_reached = None
        else:
            reached = _number(body["students_reached"], "students reached")
            if reached < 0 or reached != int(reached) or reached > 100000:
                abort(400, "the number of students must be a whole number")
            papers = sum(1 for s in b.sheets if not s.left_out)
            if b.test.hands_on_max and reached < papers:
                abort(400, f"the students in the hands-on challenge cannot be fewer than the papers ({papers})")
            b.students_reached = int(reached)
    db().commit()
    return jsonify(b.to_dict())


@api.get("/places")
@require_user
@ignite_only
def list_places():
    """The districts, blocks, schools and grades typed on earlier batches, to suggest while a
    teacher types: the same school should be spelt the same way every time."""
    rows = (db().query(Batch.state_id, Batch.district, Batch.block, Batch.school, Batch.schools_json, Batch.grade)
            .filter(Batch.district.isnot(None)).distinct().all())
    found = set()
    for r in rows:
        names = json.loads(r.schools_json) if r.schools_json else [r.school] if r.school else [""]
        found |= {(r.state_id or "", r.district or "", r.block or "", name) for name in names}
    # The districts and blocks of the programme too, spelt as the dashboard has them, with the
    # status an admin gave each block (the form warns when a batch is for a Completed block), and
    # the schools the team had already counted in each block.
    states = {key(s.name): s.id for s in db().query(State).all()}
    status = {}
    for d in (db().query(IgniteDistrict)
              .options(selectinload(IgniteDistrict.blocks).selectinload(IgniteBlock.schools)).all()):
        for b in d.blocks:
            state_id = states.get(key(d.state), "")
            found.add((state_id, d.name, b.name, ""))
            found |= {(state_id, d.name, b.name, s.name) for s in b.schools}
            status[(key(d.name), place_key(b.name))] = b.status or ""
    places = sorted(found)
    return jsonify({"places": [{"state_id": s, "district": d, "block": b, "school": sc,
                                "status": status.get((key(d), place_key(b)), "") if not sc else ""}
                               for s, d, b, sc in places],
                    "grades": sorted({r.grade for r in rows if r.grade})})


# ---- correcting a sheet --------------------------------------------------------------------

def _reading(s: Sheet) -> dict:
    return {"status": s.status, "error_reason": s.error_reason, "fields": s.fields, "answers": s.answers,
            "score": s.score, "needs_review": bool(s.needs_review), "review_reason": s.review_reason}


def _typed_field(label: str, value) -> str:
    if label == "gender":
        text = clean_text(value, 10)
        if text and text.lower() not in GENDERS:
            abort(400, "gender must be Male or Female, or left empty")
        return GENDERS.get(text.lower(), "")
    if label == "Mobile Number":
        text = "".join(str(value or "").split())
        if text and not text.isdigit():
            abort(400, "the mobile number must be digits only")
        return text[:FIELD_LIMITS[label]]
    return clean_text(value, FIELD_LIMITS.get(label, 100))


@api.patch("/sheets/<sheet_id>")
@require_user
@ignite_only
def correct_sheet(sheet_id):
    """Corrects what was read from a sheet, or types in a sheet that could not be read. The body
    may have: fields ({"Name": ...}), answers ({"q7": "B"}; "" for no answer), hands_on_score,
    left_out, confirm (the sheet is right now: it no longer needs a check) and restore (put the
    first reading back). The score is worked out again; the first reading and who changed what
    are kept on the sheet."""
    s = db().get(Sheet, sheet_id) or abort(404)
    b = s.batch
    test = b.test
    _open_for_changes(b)
    body = request.get_json(force=True) or {}
    before = _reading(s)
    fields, answers = s.fields, s.answers
    changed = []

    def change(what, old, new):
        changed.append({"what": what, "from": old, "to": new})

    if body.get("restore"):
        first = s.original or abort(400, "this sheet's reading was never changed")
        s.status, s.error_reason = first["status"], first["error_reason"]
        fields, answers = first["fields"], first["answers"]
        s.score, s.needs_review, s.review_reason = first["score"], first["needs_review"], first["review_reason"]
        s.confirmed_by = s.confirmed_at = s.entered_by_hand = s.original_json = None
        change("First reading put back", "", "")
    else:
        typed = "fields" in body or "answers" in body
        if s.status == "error" and typed:
            # Typed in by hand from the paper: every detail and question starts empty.
            fields = {k: "" for k in engine().field_labels}
            answers = {k: "" for k in engine().question_labels}
        for label, value in (body.get("fields") or {}).items():
            if label not in engine().field_labels:
                abort(400, f"there is no {label} on the sheet")
            value = _typed_field(label, value)
            if value != (fields.get(label) or ""):
                change(label, fields.get(label) or "", value)
                fields[label] = value
        for q, value in (body.get("answers") or {}).items():
            if q not in engine().question_labels:
                abort(400, f"there is no {q} on the sheet")
            value = str(value or "").strip().upper()
            # More than one letter only where the key asks for several bubbles to be filled.
            several = needs_all(test.answer_key.get(q, ""))
            if (any(ch not in test.options for ch in value) or len(set(value)) != len(value)
                    or (len(value) > 1 and not several)):
                abort(400, f"the answer for {q} must be one of {test.options}, or empty")
            value = "".join(sorted(value, key=test.options.index))
            if value != (answers.get(q) or ""):
                change(q, answers.get(q) or "", value)
                answers[q] = value
        if s.status == "error" and typed:
            s.status, s.error_reason, s.entered_by_hand = "ok", "", True
            s.needs_review, s.review_reason = False, ""
            s.confirmed_by, s.confirmed_at = g.user.email, now()
            change("Typed in by hand", before["error_reason"], "")
        if s.status == "ok":
            s.score = score_answers(answers, test.answer_key, test.marks_correct, test.marks_incorrect,
                                    test.marks_unmarked)
        if body.get("confirm"):
            if s.status != "ok":
                abort(400, "type in what is on this sheet first, or leave it out")
            if s.needs_review:
                s.needs_review, s.review_reason = False, ""
                s.confirmed_by, s.confirmed_at = g.user.email, now()
                change("Checked", before["review_reason"], "")

    if "hands_on_score" in body:
        marks = None if body["hands_on_score"] in (None, "") else _number(body["hands_on_score"], "the hands-on score")
        if marks is not None:
            if test.hands_on_max is None:
                abort(400, "this answer key takes no hands-on score")
            if not 0 <= marks <= test.hands_on_max:
                abort(400, f"the hands-on score must be between 0 and {test.hands_on_max:g}")
        if marks != s.hands_on_score:
            change("Hands-on score", s.hands_on_score, marks)
            s.hands_on_score = marks
    if "left_out" in body and bool(body["left_out"]) != bool(s.left_out):
        change("Left out", bool(s.left_out), bool(body["left_out"]))
        s.left_out = bool(body["left_out"])

    if changed:
        after = {**_reading(s), "fields": fields, "answers": answers}
        if s.original_json is None and after != before and not body.get("restore"):
            s.original_json = json.dumps(before)
        s.fields_json, s.answers_json = json.dumps(fields), json.dumps(answers)
        s.changes_json = json.dumps(s.changes + [{"by": g.user.email, "at": iso(now()), "changes": changed}])
        db().commit()
    return jsonify(sheet_dict(s, test.answer_key, test.skill_map))


# ---- sending a checked batch to the admin ------------------------------------------------

def _count(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


@api.post("/batches/<batch_id>/submit")
@require_user
@ignite_only
def submit_batch(batch_id):
    """The teacher says this batch is checked and complete. Refused while a sheet still needs a
    check or could not be read (each is corrected, typed in or left out first), and while the
    batch does not say which district and block it is from. With an activity score on the answer
    key, also while a paper has no activity score, and until the number of students in the
    hands-on challenge is typed, at least as many as the papers (answers 1 and 10)."""
    b = db().get(Batch, batch_id, options=_BATCH_COUNTS) or abort(404)
    if b.submitted_at:
        return jsonify(b.to_dict())
    sheets = [s for s in b.sheets if not s.left_out]
    if not sheets:
        abort(400, "this batch has no sheets yet")
    to_check = sum(1 for s in sheets if s.status == "ok" and s.needs_review)
    unread = sum(1 for s in sheets if s.status == "error")
    if to_check or unread:
        parts = ([_count(to_check, "sheet still needs a check", "sheets still need a check")] if to_check else []) \
            + ([_count(unread, "sheet could not be read", "sheets could not be read")] if unread else [])
        abort(400, " and ".join(parts) + ". Correct them, type them in or leave them out first.")
    if b.test.hands_on_max:
        no_score = sum(1 for s in sheets if s.hands_on_score is None)
        if no_score:
            abort(400, _count(no_score, "paper has", "papers have") + " no activity score yet. Type "
                  + ("it" if no_score == 1 else "them") + " first.")
    missing = [what for what, value in (("state", b.state_id), ("district", b.district), ("block", b.block))
               if not value]
    if missing:
        abort(400, "add the " + " and the ".join(missing) + " of this batch first")
    if b.test.hands_on_max:
        if b.students_reached is None:
            abort(400, "type how many students did the hands-on challenge first")
        if b.students_reached < len(sheets):
            abort(400, f"the students in the hands-on challenge ({b.students_reached}) cannot be fewer than "
                       f"the papers ({len(sheets)})")
    b.submitted_at, b.submitted_by = now(), g.user.email
    db().commit()
    return jsonify(b.to_dict())


@api.post("/batches/<batch_id>/reopen")
@require_admin
@ignite_only
def reopen_batch(batch_id):
    """An admin sends a submitted batch back, so the teacher can change it again."""
    b = db().get(Batch, batch_id, options=_BATCH_COUNTS) or abort(404)
    b.submitted_at = b.submitted_by = None
    db().commit()
    return jsonify(b.to_dict())
