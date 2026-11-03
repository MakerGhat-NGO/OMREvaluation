"""JSON API. Every route needs an approved user; user management needs an admin."""
from __future__ import annotations

import csv
import io
import json
import re
from datetime import datetime, timedelta, timezone

from flask import Blueprint, Response, abort, current_app, g, jsonify, request
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import selectinload
from werkzeug.exceptions import HTTPException

from omr import load_pages
from .auth import require_admin, require_user
from .models import Batch, Sheet, State, Test, User, real_name

api = Blueprint("api", __name__, url_prefix="/api")
QUESTION_RE = re.compile(r"^q\d+$")


def db():
    return current_app.extensions["db_session"]


def engine():
    return current_app.extensions["omr_engine"]


def storage():
    return current_app.extensions["storage"]


def now():
    return datetime.now(timezone.utc)


# ---- who am I -----------------------------------------------------------------

@api.get("/me")
def me():
    user = getattr(g, "user", None)
    if user is None:
        return jsonify({"signed_in": False}), 401
    return jsonify({"signed_in": True, "user": user.to_dict(),
                    "sheet": {"question_count": len(engine().question_labels),
                              "field_labels": engine().field_labels}})


# ---- users (admin) -------------------------------------------------------------

@api.get("/users")
@require_admin
def list_users():
    users = db().query(User).order_by(User.status.desc(), User.created_at).all()
    return jsonify([u.to_dict() for u in users])


@api.patch("/users/<user_id>")
@require_admin
def update_user(user_id):
    user = db().get(User, user_id) or abort(404)
    body = request.get_json(force=True) or {}
    if "status" in body:
        if body["status"] not in ("pending", "approved", "disabled"):
            abort(400, "bad status")
        if user.id == g.user.id and body["status"] != "approved":
            abort(400, "you cannot disable your own account")
        user.status = body["status"]
        if body["status"] == "approved":
            user.approved_by = g.user.email
    if "role" in body:
        if body["role"] not in ("teacher", "admin"):
            abort(400, "bad role")
        if user.id == g.user.id and body["role"] != "admin":
            abort(400, "you cannot remove your own admin role")
        user.role = body["role"]
    if "name" in body:
        user.name = str(body["name"])[:200]
    db().commit()
    return jsonify(user.to_dict())


# ---- tests and answer keys ------------------------------------------------------

def _validate_test(body, question_count_max):
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, "name is required")
    qn = int(body.get("question_count") or question_count_max)
    if not 1 <= qn <= question_count_max:
        abort(400, f"question_count must be between 1 and {question_count_max}")
    options = (body.get("options") or "ABCDE").upper()
    if not re.fullmatch(r"[A-Z]{2,26}", options):
        abort(400, "options must be letters, for example ABCD")
    key = body.get("answer_key") or {}
    clean = {}
    for i in range(1, qn + 1):
        v = (key.get(f"q{i}") or "").strip().upper()
        if v and (len(v) != 1 or v not in options):
            abort(400, f"answer for q{i} must be one of {options}")
        if v:
            clean[f"q{i}"] = v
    return name, qn, options, clean


@api.get("/tests")
@require_user
def list_tests():
    q = db().query(Test)
    if request.args.get("include_archived") != "1":
        # "== False" compiles to "= 0" everywhere; ".is_(False)" gives "IS 0", which SQL Server rejects.
        q = q.filter(Test.archived == False)  # noqa: E712
    return jsonify([t.to_dict() for t in q.order_by(Test.created_at.desc()).all()])


@api.post("/tests")
@require_user
def create_test():
    body = request.get_json(force=True) or {}
    name, qn, options, key = _validate_test(body, len(engine().question_labels))
    t = Test(name=name, question_count=qn, options=options,
             marks_correct=float(body.get("marks_correct", 1)),
             marks_incorrect=float(body.get("marks_incorrect", 0)),
             marks_unmarked=float(body.get("marks_unmarked", 0)),
             created_by=g.user.email)
    t.answer_key = key
    db().add(t)
    db().commit()
    return jsonify(t.to_dict()), 201


@api.get("/tests/<test_id>")
@require_user
def get_test(test_id):
    t = db().get(Test, test_id) or abort(404)
    return jsonify(t.to_dict())


@api.put("/tests/<test_id>")
@require_user
def update_test(test_id):
    t = db().get(Test, test_id) or abort(404)
    body = request.get_json(force=True) or {}
    merged = {**t.to_dict(), **body}
    name, qn, options, key = _validate_test(merged, len(engine().question_labels))
    t.name, t.question_count, t.options = name, qn, options
    t.marks_correct = float(merged.get("marks_correct", 1))
    t.marks_incorrect = float(merged.get("marks_incorrect", 0))
    t.marks_unmarked = float(merged.get("marks_unmarked", 0))
    t.answer_key = key
    t.archived = bool(merged.get("archived", False))
    db().commit()
    return jsonify(t.to_dict())


# ---- states ---------------------------------------------------------------------------

def _clean_name(value) -> str:
    """A typed name with its spaces tidied, at most 200 letters."""
    return " ".join(str(value or "").split())[:200]


@api.get("/states")
@require_user
def list_states():
    return jsonify([s.to_dict() for s in db().query(State).order_by(State.name).all()])


@api.post("/states")
@require_user
def create_state():
    """Makes a state, or answers with the one of that name (whatever its capitals) if it exists:
    two teachers typing "Maharashtra" get one state, not two."""
    body = request.get_json(force=True) or {}
    name = _clean_name(body.get("name"))
    if not name:
        abort(400, "state name is required")
    if existing := _state_named(name):
        return jsonify(existing.to_dict()), 200
    s = State(name=name, created_by=g.user.email)
    db().add(s)
    try:
        db().commit()
    except IntegrityError:
        # Made by someone else between the look and the save.
        db().rollback()
        return jsonify(_state_named(name).to_dict()), 200
    return jsonify(s.to_dict()), 201


def _state_named(name):
    return next((s for s in db().query(State).all() if s.name.lower() == name.lower()), None)


# ---- batches and sheets -----------------------------------------------------------

# Batch.to_dict counts each batch's sheets and averages their scores. Load just those columns of the
# sheets of every batch asked for, in one query (not one query per batch, and not the long text
# columns), and their answer keys and states in one more each.
_BATCH_COUNTS = (selectinload(Batch.sheets).load_only(Sheet.status, Sheet.needs_review, Sheet.score),
                 selectinload(Batch.test), selectinload(Batch.state))


@api.get("/batches")
@require_user
def list_batches():
    q = db().query(Batch).options(*_BATCH_COUNTS).order_by(Batch.created_at.desc())
    if request.args.get("test_id"):
        q = q.filter(Batch.test_id == request.args["test_id"])
    if request.args.get("state_id"):
        q = q.filter(Batch.state_id == request.args["state_id"])
    return jsonify([b.to_dict() for b in q.limit(200).all()])


@api.post("/batches")
@require_user
def create_batch():
    """Makes a batch for a test, filed under a state. A batch of that name (whatever its capitals)
    for the same test and state is answered with instead of being made again: sheets can be added
    to a batch at any time, and one batch per school and class is the point."""
    body = request.get_json(force=True) or {}
    test = db().get(Test, body.get("test_id") or "") or abort(400, "test_id is required")
    if not test.answer_key:
        abort(400, "this test has no answer key yet")
    name = _clean_name(body.get("name"))
    if not name:
        abort(400, "batch name is required")
    state = None
    if body.get("state_id"):
        state = db().get(State, body["state_id"]) or abort(400, "this state was not found")
    same = (db().query(Batch).options(*_BATCH_COUNTS)
            .filter(Batch.test_id == test.id, Batch.state_id == (state.id if state else None)).all())
    if existing := next((b for b in same if b.name.lower() == name.lower()), None):
        return jsonify(existing.to_dict()), 200
    b = Batch(test_id=test.id, state_id=state.id if state else None, name=name, created_by=g.user.email)
    db().add(b)
    db().commit()
    return jsonify(b.to_dict()), 201


@api.get("/batches/<batch_id>")
@require_user
def get_batch(batch_id):
    b = db().get(Batch, batch_id, options=_BATCH_COUNTS) or abort(404)
    return jsonify(b.to_dict())


@api.post("/batches/<batch_id>/finish")
@require_user
def finish_batch(batch_id):
    b = db().get(Batch, batch_id, options=_BATCH_COUNTS) or abort(404)
    b.status, b.finished_at = "finished", now()
    db().commit()
    return jsonify(b.to_dict())


@api.delete("/batches/<batch_id>")
@require_user
def delete_batch(batch_id):
    b = db().get(Batch, batch_id) or abort(404)
    if b.created_by != g.user.email and g.user.role != "admin":
        abort(403, "only the uploader or an admin can delete a batch")
    storage().delete_prefix(f"batches/{b.id}")
    db().delete(b)
    db().commit()
    return "", 204


@api.post("/batches/<batch_id>/sheets")
@require_user
def upload_sheet(batch_id):
    """One request per scanned page. The browser normally sends a shrunk JPEG; a PDF also works
    and every page of it is read."""
    b = db().get(Batch, batch_id) or abort(404)
    # Sheets can be added to a batch at any time: a new run of checking opens it again, and its
    # finish call closes it.
    b.status = "open"
    f = request.files.get("file") or abort(400, "file is required")
    data = f.read()
    if not data:
        abort(400, "empty file")
    source_name = (request.form.get("source_name") or f.filename or "sheet")[:300]
    page_offset = int(request.form.get("page_no") or 1)
    try:
        pages = load_pages(data, f.filename or source_name)
    except ValueError as exc:
        abort(400, str(exc))

    test = b.test
    # The browser sends retry=1 when it sends a page again after a dropped connection or a busy
    # server. The first try may have been saved anyway, with only its reply lost on the way, so a page
    # that is already saved is answered with that sheet instead of being read and saved twice. A first
    # try never looks: a tab still running an older version of the app can send two different photos
    # that are both called image.jpg.
    retry = request.form.get("retry") == "1"
    results = []
    for i, page in enumerate(pages):
        page_no = page_offset + i
        if retry and (saved := _saved_sheet(b.id, source_name, page_no)):
            results.append(saved)
            continue
        r = engine().evaluate(page, test.answer_key, name=f"{b.id}-{page_no}",
                              marks_correct=test.marks_correct, marks_incorrect=test.marks_incorrect,
                              marks_unmarked=test.marks_unmarked)
        # Reading takes a few seconds, and the first try may have been running all the while: look again.
        if retry and (saved := _saved_sheet(b.id, source_name, page_no)):
            results.append(saved)
            continue
        sheet = Sheet(batch_id=b.id, source_name=source_name, page_no=page_no, created_by=g.user.email,
                      status="ok" if r.ok else "error", error_reason=r.error_reason,
                      score=r.score, needs_review=r.needs_review, review_reason=r.review_reason)
        sheet.fields_json = json.dumps(r.fields)
        sheet.answers_json = json.dumps(r.answers)
        db().add(sheet)
        db().flush()
        prefix = f"batches/{b.id}/{sheet.id}"
        if len(pages) == 1:
            sheet.input_path = f"{prefix}/input{_ext(f.filename)}"
            storage().put(sheet.input_path, data, f.mimetype or "application/octet-stream")
        else:
            import cv2
            ok, jpg = cv2.imencode(".jpg", page, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ok:
                sheet.input_path = f"{prefix}/input.jpg"
                storage().put(sheet.input_path, jpg.tobytes(), "image/jpeg")
        if r.checked_image_jpeg:
            sheet.checked_path = f"{prefix}/checked.jpg"
            storage().put(sheet.checked_path, r.checked_image_jpeg, "image/jpeg")
            if r.layout:
                storage().put(f"{prefix}/layout.json", json.dumps({"boxes": r.layout}).encode(), "application/json")
        results.append(sheet)
    db().commit()
    return jsonify([s.to_dict() for s in results]), 201


def _saved_sheet(batch_id, source_name, page_no):
    """The sheet this batch already has for this page of this file, if any."""
    return (db().query(Sheet)
            .filter(Sheet.batch_id == batch_id, Sheet.source_name == source_name, Sheet.page_no == page_no)
            .order_by(Sheet.created_at)
            .first())


def _ext(filename):
    name = (filename or "").lower()
    for ext in (".pdf", ".jpg", ".jpeg", ".png"):
        if name.endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    return ".bin"


@api.get("/batches/<batch_id>/sheets")
@require_user
def list_sheets(batch_id):
    b = db().get(Batch, batch_id) or abort(404)
    sheets = sorted(b.sheets, key=lambda s: (s.source_name, s.page_no))
    return jsonify([s.to_dict() for s in sheets])


@api.get("/sheets/<sheet_id>/image")
@require_user
def sheet_image(sheet_id):
    s = db().get(Sheet, sheet_id) or abort(404)
    key = s.checked_path if request.args.get("kind", "checked") == "checked" else s.input_path
    if not key:
        abort(404)
    data = storage().get_or_none(key)
    if data is None:
        # Storage deletes pictures after the time set in docs/AZURE_SETUP.md; the sheet's row stays.
        abort(404, "this picture is no longer kept")
    mime = "application/pdf" if key.endswith(".pdf") else ("image/png" if key.endswith(".png") else "image/jpeg")
    return Response(data, mimetype=mime, headers={"Cache-Control": "private, max-age=3600"})


@api.get("/sheets/<sheet_id>/layout")
@require_user
def sheet_layout(sheet_id):
    """Where each question and field sits on the checked picture (fractions of its size), so the
    page can draw a box around the questions a teacher should look at."""
    s = db().get(Sheet, sheet_id) or abort(404)
    if not s.checked_path:
        abort(404, "this sheet has no checked picture")
    data = storage().get_or_none(s.checked_path.rsplit("/", 1)[0] + "/layout.json")
    if data is None:
        abort(404, "this sheet was checked before question positions were recorded")
    return Response(data, mimetype="application/json", headers={"Cache-Control": "private, max-age=3600"})


# ---- results for Google Sheets and Excel ------------------------------------------------

# The columns of the sheet the field team keeps results in (the "OMR format"), in its order. The
# tool fills in what it knows from the batch and the scan; District, Block, Cluster, the date of
# the assessment, the school, the grade and the hands-on score are written on the sheet by hand or
# known to the team, so those columns are left empty for them to fill in.
EXPORT_COLUMNS = ["Sr No", "State", "District", "Block", "Cluster (if get)", "Date of assessment",
                  "Date of data entry", "Fellow/Team Member Name", "School Name", "Student Name",
                  "Roll number", "Mobile Number", "Gender", "Grade", "Hand-on Activity Score",
                  "Assessment Score"]
# After the questions: what the tool found that a person should know.
EXPORT_EXTRA = ["Needs a check", "Reason", "Scan file"]
INDIA = timezone(timedelta(hours=5, minutes=30))


def _scan_label(s: Sheet) -> str:
    """"class7.pdf, page 3", or the photo's name (as the app shows it)."""
    if s.source_name.lower().endswith(".pdf") or s.page_no > 1:
        return f"{s.source_name}, page {s.page_no}"
    return s.source_name


def _export_rows(b: Batch):
    """The header and one row per sheet, as values: dates as dates, scores as numbers, and the roll
    and mobile numbers as text so that a roll number "03" keeps its zero."""
    qlabels = [f"q{i}" for i in range(1, b.test.question_count + 1)]
    names = {u.email: real_name(u.name) for u in db().query(User).all()}
    state = b.state.name if b.state else ""

    def person(email):
        email = email or b.created_by or ""
        return names.get(email) or email.split("@")[0]

    rows = []
    for n, s in enumerate(sorted(b.sheets, key=lambda s: (s.source_name, s.page_no)), start=1):
        f, a = s.fields, s.answers
        checked = s.created_at or b.created_at
        entered = (checked if checked.tzinfo else checked.replace(tzinfo=timezone.utc)).astimezone(INDIA).date()
        rows.append([n, state, "", "", "", "", entered, person(s.created_by), "",
                     (f.get("Name") or "").strip().title(), (f.get("Roll Number") or "").strip(),
                     (f.get("Mobile Number") or "").strip(), (f.get("gender") or "").strip(), "", "",
                     "" if s.score is None else s.score]
                    + [a.get(k, "") for k in qlabels]
                    + ["yes" if s.needs_review or s.status == "error" else "",
                       s.error_reason or s.review_reason, _scan_label(s)])
    return EXPORT_COLUMNS + qlabels + EXPORT_EXTRA, rows


def _export_name(b: Batch, ext: str) -> str:
    parts = [b.state.name if b.state else "", b.name, b.test.name, f"{b.created_at:%Y-%m-%d}"]
    return (re.sub(r"[^A-Za-z0-9_-]+", "_", "_".join(p for p in parts if p)).strip("_") or "results") + ext


def _plain(value):
    """A value as CSV text: a date as 2026-11-03, a whole-number score without ".0"."""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


@api.get("/batches/<batch_id>/results.csv")
@require_user
def results_csv(batch_id):
    b = db().get(Batch, batch_id, options=_BATCH_COUNTS) or abort(404)
    header, rows = _export_rows(b)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(header)
    for row in rows:
        w.writerow([_plain(v) for v in row])
    # The byte-order mark makes Excel read the file as UTF-8, so Marathi names come out right.
    return Response("\ufeff" + out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{_export_name(b, ".csv")}"'})


@api.get("/batches/<batch_id>/results.xlsx")
@require_user
def results_xlsx(batch_id):
    """The same rows as a workbook: Google Sheets and Excel open it with the headings in bold, the
    roll numbers kept as written, and the dates as dates."""
    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    b = db().get(Batch, batch_id, options=_BATCH_COUNTS) or abort(404)
    header, rows = _export_rows(b)
    wb = Workbook()
    ws = wb.active
    ws.title = "Results"
    ws.append(header)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(row)
    date_column = header.index("Date of data entry") + 1
    for row_no in range(2, len(rows) + 2):
        ws.cell(row=row_no, column=date_column).number_format = "DD-MM-YYYY"
    widths = {"Sr No": 7, "State": 16, "District": 14, "Block": 14, "Cluster (if get)": 16, "Date of assessment": 18,
              "Date of data entry": 18, "Fellow/Team Member Name": 26, "School Name": 28, "Student Name": 28,
              "Roll number": 13, "Mobile Number": 15, "Gender": 10, "Grade": 8, "Hand-on Activity Score": 20,
              "Assessment Score": 17, "Needs a check": 14, "Reason": 44, "Scan file": 32}
    for i, title in enumerate(header, start=1):
        ws.column_dimensions[get_column_letter(i)].width = widths.get(title, 6)
    ws.freeze_panes = "A2"
    out = io.BytesIO()
    wb.save(out)
    return Response(out.getvalue(), mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{_export_name(b, ".xlsx")}"'})


# ---- errors as JSON -----------------------------------------------------------------

@api.errorhandler(400)
@api.errorhandler(401)
@api.errorhandler(403)
@api.errorhandler(404)
@api.errorhandler(413)
def _json_error(err):
    return jsonify({"error": getattr(err, "description", str(err))}), err.code


@api.errorhandler(OperationalError)
def _db_error(err):
    current_app.logger.exception("database error")
    return jsonify({"error": "the database is starting up or unavailable, please try again in a minute"}), 503


@api.errorhandler(Exception)
def _unexpected_error(err):
    """Anything else: log the traceback and tell the page what went wrong, instead of a bare HTML 500."""
    if isinstance(err, HTTPException):
        return err
    current_app.logger.exception("unhandled error in %s", request.path)
    return jsonify({"error": f"unexpected error: {type(err).__name__}: {err}"[:500]}), 500
