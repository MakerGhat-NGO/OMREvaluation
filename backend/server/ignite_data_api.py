"""The IGNITE admin routes: the programme (districts and blocks), taking over the team's sheet, the
review of what the dashboard will show, Publish and restore. And the one open address, the feed
the dashboard reads: it gives the numbers an admin published last, and nothing else.

Every one answers 404 unless IGNITE_ENABLED is set."""
from __future__ import annotations

import io
import json
from datetime import date, timezone

from flask import Response, abort, g, jsonify, request
from sqlalchemy.orm import selectinload

from .api import api, db, now, storage
from .auth import require_admin
from .ignite import INDIA, clean_schools, clean_text, school_key, school_of
from .ignite_api import ignite_only
from .ignite_feed import (COUNTS, FIGURES, build_feed, counted, district_totals, hands_on_max, history_tab, key,
                          numbers_of, percent_of, place_key, published_figures, most_marks, tally, tidy, top_sheet,
                          work_out)
from .ignite_import import apply_import, read_workbook
from .models import (Batch, IgniteBlock, IgniteDay, IgniteDistrict, IgniteSchool, IgniteSetting, IgniteSnapshot, Sheet,
                     iso)

STATUSES = ("Not started", "In Progress", "Completed")
FEED_KEY = "ignite/feed.json"       # the last publish, as a file in the app's storage
MOST_COUNTED = 2000                 # schools already counted in one block


# ---- what is typed ------------------------------------------------------------------------------

def _whole(value, what: str):
    """A whole number that is not below 0; nothing typed is None."""
    if value in (None, ""):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        abort(400, f"{what} must be a number")
    if n < 0 or n != int(n) or n > 100_000_000:
        abort(400, f"{what} must be a whole number")
    return int(n)


def _figure(name: str, value):
    """One figure of a block as typed: a count, a share from 0 to 1, or the hands-on average."""
    if value in (None, ""):
        return None
    if name in COUNTS:
        return _whole(value, "the figure")
    try:
        n = float(value)
    except (TypeError, ValueError):
        abort(400, "the figure must be a number")
    if n < 0 or (name != "hands_avg" and n > 1) or n > 1000:
        abort(400, "a share must be between 0% and 100%" if name != "hands_avg" else "the average cannot be below 0")
    return n


def _day(value):
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        abort(400, "the date must look like 2026-11-10")


def _latest():
    return db().query(IgniteSnapshot).order_by(IgniteSnapshot.published_at.desc()).first()


# ---- the review screen ------------------------------------------------------------------------

def completed(status) -> bool:
    return key(status) == "completed"


def _batch_row(batch: Batch, block_completed: bool = False, counted_before=frozenset()) -> dict:
    """block_completed: the batch is filed under a block an admin marked Completed. The team said
    no more papers come for such a block (answers 18 and 21), so the review screen flags it.
    counted_before: the block's schools the team had already counted; the batch's schools among
    them are listed, as they add no school."""
    t = tally(batch)
    return {"id": batch.id, "name": batch.name, "test_name": batch.test.name if batch.test else "",
            "state_name": batch.state.name if batch.state else "", "district": batch.district or "",
            "block": batch.block or "", "school": ", ".join(batch.schools), "schools": batch.schools,
            "schools_counted_before": [s for s in batch.schools if school_key(s) in counted_before],
            "grade": batch.grade or "",
            "assessed_on": batch.assessed_on.isoformat() if batch.assessed_on else None,
            "submitted_at": iso(batch.submitted_at), "submitted_by": batch.submitted_by or "",
            "sheets": t["sheets"], "average": round(t["share_sum"] / t["sheets"], 4) if t["sheets"] else None,
            "students_reached": t["students_reached"], "hands_on_count": t["hands_count"],
            "left_out": bool(batch.dashboard_left_out), "block_completed": block_completed}


def _district_dict(d: IgniteDistrict) -> dict:
    return {"id": d.id, "state": d.state or "", "name": d.name, "position": d.position,
            "blocks_count": d.blocks_count, "total_schools": d.total_schools, "grade": d.grade or "",
            "total_students": d.total_students, "target_date": d.target_date.isoformat() if d.target_date else None}


def _block_dict(row: dict, published: dict) -> dict:
    b = row["block"]
    return {"id": b.id, "district_id": b.district_id, "name": b.name, "position": b.position,
            "total_schools": b.total_schools, "selected_schools": b.selected_schools,
            "student_target": b.student_target, "status": b.status or "", "status_shown": row["status"],
            "opening": {k: b.opening.get(k) for k in FIGURES},
            "added": {k: tidy(k, v) for k, v in row["added"].items()},
            "worked_out": {k: tidy(k, v) for k, v in row["figures"].items()},
            "overrides": {k: v for k, v in b.overrides.items() if k in FIGURES},
            "shown": row["shown"], "published": published.get((key(b.district.name), place_key(b.name))),
            "schools_counted": [s.name for s in b.schools],
            "batches": [_batch_row(x, completed(b.status), {school_key(s.name) for s in b.schools})
                        for x in row["batches"]]}


@api.get("/ignite/overview")
@require_admin
@ignite_only
def ignite_overview():
    """Everything the review screen shows: each district and block with its numbers as they stand
    now beside the published ones, the batches behind them, the submitted batches that match no
    block, the batches teachers are still working on, and the last publish."""
    picture = work_out(db())
    last = _latest()
    last_feed = json.loads(last.feed_json) if last else None
    published = published_figures(last_feed) if last_feed else {}
    districts = []
    for entry in picture["districts"]:
        d = entry["district"]
        districts.append({**_district_dict(d), "top_imported": len(d.top_rows),
                          "top_marked": sum(1 for row in entry["blocks"] for x in row["batches"]
                                            if not x.dashboard_left_out for s in counted(x) if s.top5 or s.top1),
                          "blocks": [_block_dict(row, published) for row in entry["blocks"]]})
    working = (db().query(Batch).filter(Batch.submitted_at.is_(None), Batch.district.isnot(None))
               .options(selectinload(Batch.sheets).load_only(Sheet.status, Sheet.left_out))
               .order_by(Batch.created_at.desc()).limit(50).all())
    changed = bool(districts) and (last_feed is None
                                   or numbers_of(build_feed(db(), now(), picture)) != numbers_of(last_feed))
    return jsonify({
        "settings": {"hands_on_max": hands_on_max(db())},
        "statuses": STATUSES,
        "districts": districts,
        "unmatched": [_batch_row(x) for x in picture["unmatched"]],
        "working": [{"id": x.id, "name": x.name, "district": x.district or "", "block": x.block or "",
                     "school": ", ".join(x.schools), "created_by": x.created_by,
                     "sheets": sum(1 for s in x.sheets if not s.left_out)} for x in working],
        "last_publish": last.to_dict() if last else None,
        "publishes": db().query(IgniteSnapshot).count(),
        "changed": changed,
    })


@api.get("/ignite/preview")
@require_admin
@ignite_only
def ignite_preview():
    """The numbers as they would be published now, in the dashboard's shape."""
    return jsonify(build_feed(db(), now()))


# ---- the programme ------------------------------------------------------------------------------

def _set_district(d: IgniteDistrict, body: dict) -> None:
    if "name" in body:
        name = clean_text(body["name"]) or abort(400, "type the name of the district")
        if any(key(o.name) == key(name) and o.id != d.id for o in db().query(IgniteDistrict).all()):
            abort(400, f"there is already a district called {name}")
        d.name = name
    if "state" in body:
        d.state = clean_text(body["state"])
    if "grade" in body:
        d.grade = clean_text(body["grade"], 50) or None
    for field, what in (("blocks_count", "the number of blocks"), ("total_schools", "the number of schools"),
                        ("total_students", "the number of students")):
        if field in body:
            setattr(d, field, _whole(body[field], what))
    if "target_date" in body:
        d.target_date = _day(body["target_date"])


@api.post("/ignite/districts")
@require_admin
@ignite_only
def add_district():
    body = request.get_json(force=True) or {}
    last = db().query(IgniteDistrict).order_by(IgniteDistrict.position.desc()).first()
    d = IgniteDistrict(name="", position=(last.position if last else 0) + 1)
    _set_district(d, {"name": "", **body})
    db().add(d)
    db().commit()
    return jsonify(_district_dict(d)), 201


@api.patch("/ignite/districts/<district_id>")
@require_admin
@ignite_only
def update_district(district_id):
    d = db().get(IgniteDistrict, district_id) or abort(404)
    _set_district(d, request.get_json(force=True) or {})
    db().commit()
    return jsonify(_district_dict(d))


@api.delete("/ignite/districts/<district_id>")
@require_admin
@ignite_only
def delete_district(district_id):
    """Takes a district off the dashboard, with its blocks and the top students taken from the
    sheet. The batches teachers scanned are not touched."""
    d = db().get(IgniteDistrict, district_id) or abort(404)
    db().delete(d)
    db().commit()
    return "", 204


def _set_block(b: IgniteBlock, d: IgniteDistrict, body: dict) -> None:
    if "name" in body:
        name = clean_text(body["name"]) or abort(400, "type the name of the block")
        if any(key(o.name) == key(name) and o.id != b.id for o in d.blocks):
            abort(400, f"{d.name} already has a block called {name}")
        b.name = name
    for field, what in (("total_schools", "the number of schools"), ("selected_schools", "the schools selected"),
                        ("student_target", "the number of students")):
        if field in body:
            setattr(b, field, _whole(body[field], what))
    if "status" in body:
        b.status = clean_text(body["status"], 50) or None
    if "opening" in body:
        typed = body["opening"] or {}
        if not isinstance(typed, dict) or any(k not in FIGURES for k in typed):
            abort(400, "that is not a figure of a block")
        b.opening_json = json.dumps({**b.opening, **{k: _figure(k, v) for k, v in typed.items()}})
    if "overrides" in body:
        typed = body["overrides"] or {}
        if not isinstance(typed, dict) or any(k not in FIGURES for k in typed):
            abort(400, "that is not a figure of a block")
        kept = b.overrides
        for k, v in typed.items():
            value = _figure(k, (v or {}).get("value")) if isinstance(v, dict) else None
            if value is None:
                kept.pop(k, None)                      # back to the worked-out figure
            else:
                kept[k] = {"value": value, "note": clean_text(v.get("note"), 300), "by": g.user.email,
                           "at": iso(now())}
        b.overrides_json = json.dumps(kept) if kept else None
    if "schools_counted" in body:
        # The schools the team's sheet had already counted in this block, pasted one per line
        # (or sent as a list). They replace the list the block had.
        typed = body["schools_counted"]
        names = clean_schools(typed.splitlines() if isinstance(typed, str) else typed or [], MOST_COUNTED)
        b.schools = [IgniteSchool(name=name, position=i) for i, name in enumerate(names)]


@api.post("/ignite/blocks")
@require_admin
@ignite_only
def add_block():
    body = request.get_json(force=True) or {}
    d = db().get(IgniteDistrict, body.get("district_id") or "") or abort(404)
    b = IgniteBlock(name="", position=max((x.position for x in d.blocks), default=0) + 1)
    _set_block(b, d, {"name": "", **body})
    d.blocks.append(b)
    db().commit()
    return jsonify({"id": b.id, "district_id": d.id, "name": b.name}), 201


@api.patch("/ignite/blocks/<block_id>")
@require_admin
@ignite_only
def update_block(block_id):
    b = db().get(IgniteBlock, block_id) or abort(404)
    _set_block(b, b.district, request.get_json(force=True) or {})
    db().commit()
    return jsonify({"id": b.id, "district_id": b.district_id, "name": b.name})


@api.delete("/ignite/blocks/<block_id>")
@require_admin
@ignite_only
def delete_block(block_id):
    b = db().get(IgniteBlock, block_id) or abort(404)
    db().delete(b)
    db().commit()
    return "", 204


@api.put("/ignite/settings")
@require_admin
@ignite_only
def set_ignite_settings():
    """hands_on_max: the scale the dashboard shows the hands-on average on, or null for none."""
    body = request.get_json(force=True) or {}
    if "hands_on_max" in body:
        most = _figure("hands_avg", body["hands_on_max"])
        if most is not None and most <= 0:
            abort(400, "the hands-on maximum must be more than 0")
        row = db().get(IgniteSetting, "hands_on_max") or IgniteSetting(key="hands_on_max")
        row.value = "" if most is None else f"{most:g}"
        db().add(row)
    db().commit()
    return jsonify({"hands_on_max": hands_on_max(db())})


@api.post("/ignite/import")
@require_admin
@ignite_only
def ignite_import():
    """Takes over the team's sheet from its Excel download: districts, blocks, their figures, the
    numbers so far as opening numbers, and the top students so far (without names)."""
    f = request.files.get("file") or abort(400, "choose the Excel file of the dashboard's sheet")
    try:
        data = read_workbook(io.BytesIO(f.read()))
    except Exception:
        abort(400, "that file could not be read. Download the sheet as Excel (.xlsx) and choose that file.")
    if not data["districts"] and not data["blocks"]:
        abort(400, "no state tab and no district tab were found in that file")
    counts = apply_import(db(), data)
    db().commit()
    return jsonify(counts)


# ---- batches and top students -----------------------------------------------------------------

@api.put("/ignite/batches/<batch_id>")
@require_admin
@ignite_only
def set_batch_on_dashboard(batch_id):
    """left_out: keep a submitted batch out of the dashboard's numbers, or put it back in."""
    b = db().get(Batch, batch_id) or abort(404)
    body = request.get_json(force=True) or {}
    if "left_out" in body:
        b.dashboard_left_out = bool(body["left_out"]) or None
    db().commit()
    return jsonify({"id": b.id, "left_out": bool(b.dashboard_left_out)})


@api.get("/ignite/top")
@require_admin
@ignite_only
def top_candidates():
    """The scanned students of a district, best score first, for an admin to mark the top 5% and
    the top 1%. This list has names: it is for admins, inside the app, and is never published."""
    entry = next((e for e in work_out(db())["districts"] if e["district"].id == request.args.get("district_id")),
                 None) or abort(404)
    students = []
    for row in entry["blocks"]:
        for batch in row["batches"]:
            if batch.dashboard_left_out:
                continue
            most = most_marks(batch.test)
            for s in counted(batch):
                top = top_sheet(s, batch, row["block"].name)
                students.append({"id": s.id, "batch_id": batch.id, "batch_name": batch.name,
                                 "name": s.fields.get("Name") or "", "school": school_of(s, batch),
                                 "block": row["block"].name, "gender": top["gender"],
                                 "score": s.score, "max_score": most, "hands_on_score": s.hands_on_score,
                                 "hands_on_max": batch.test.hands_on_max, "percent": round(percent_of(s, batch.test), 4),
                                 "skills": top["skills"], "top5": top["top5"], "top1": top["top1"]})
    students.sort(key=lambda s: (-s["percent"], s["name"].lower()))
    d = entry["district"]
    return jsonify({"district": _district_dict(d), "students": students,
                    "imported": len(d.top_rows), "imported_top1": sum(1 for r in d.top_rows if r.top1)})


@api.put("/ignite/top/<sheet_id>")
@require_admin
@ignite_only
def mark_top(sheet_id):
    """Marks a student as top 5% or top 1%. A top 1% student is in the top 5% too."""
    s = db().get(Sheet, sheet_id) or abort(404)
    body = request.get_json(force=True) or {}
    top5 = bool(body["top5"]) if "top5" in body else bool(s.top5)
    top1 = bool(body["top1"]) if "top1" in body else bool(s.top1)
    if "top1" in body and top1:
        top5 = True
    if "top5" in body and not top5:
        top1 = False
    s.top5, s.top1 = top5 or None, top1 or None
    db().commit()
    return jsonify({"id": s.id, "top5": top5, "top1": top1})


# ---- Publish ------------------------------------------------------------------------------------

@api.post("/ignite/publish")
@require_admin
@ignite_only
def ignite_publish():
    """Saves the numbers as they stand now. The dashboard shows the last ones saved."""
    body = request.get_json(silent=True) or {}
    at = now()
    feed = build_feed(db(), at)
    if not feed["blockTabs"]:
        abort(400, "add a district with its blocks first")
    snap = IgniteSnapshot(published_at=at, published_by=g.user.email, note=clean_text(body.get("note"), 500),
                          feed_json=json.dumps(feed))
    _show(snap)
    return jsonify(snap.to_dict()), 201


def _show(snap: IgniteSnapshot) -> None:
    """Saves a publish and puts its numbers where the dashboard reads them: a file beside the
    sheet pictures. The dashboard asks for the numbers every minute while someone has it open;
    read from the file, those questions never touch the database (which may be asleep, and
    would otherwise never get to sleep). The file is written before the publish is final, so a
    publish that could not reach the dashboard is not kept: the admin sees an error and tries again."""
    db().add(snap)
    db().flush()
    _keep_day(snap)
    storage().put(FEED_KEY, _with_history(snap.feed_json), "application/json")
    db().commit()


def _keep_day(snap: IgniteSnapshot) -> None:
    """Keeps each district's totals as published today, for the weekly graph: a later publish on
    the same day replaces them. A restore is a publish too, so the graph shows what the dashboard
    showed, and a restore never takes the graph back to an earlier week."""
    at = snap.published_at if snap.published_at.tzinfo else snap.published_at.replace(tzinfo=timezone.utc)
    day = at.astimezone(INDIA).date()
    earlier = {key(r.district): r for r in db().query(IgniteDay).filter(IgniteDay.day == day).all()}
    for name, totals in district_totals(json.loads(snap.feed_json)).items():
        row = earlier.pop(key(name), None) or IgniteDay(day=day)
        row.district, row.published_at = name, snap.published_at
        row.schools_reached, row.students_reached, row.assessed = (totals["schools_reached"],
                                                                   totals["students_reached"], totals["assessed"])
        db().add(row)
    for row in earlier.values():                # a district taken off since the earlier publish
        db().delete(row)
    db().flush()


def _with_history(feed_json: str) -> bytes:
    """A publish as the dashboard reads it: its numbers, with the weekly totals so far as the
    History tab. The weeks are not kept in the publish itself, so an earlier publish brought back
    still has every week."""
    feed = json.loads(feed_json)
    feed.setdefault("tabs", {})["History"] = history_tab(db().query(IgniteDay).all())
    return json.dumps(feed).encode("utf-8")


@api.get("/ignite/snapshots")
@require_admin
@ignite_only
def list_snapshots():
    rows = db().query(IgniteSnapshot).order_by(IgniteSnapshot.published_at.desc()).limit(50).all()
    return jsonify([s.to_dict() for s in rows])


@api.post("/ignite/snapshots/<snapshot_id>/restore")
@require_admin
@ignite_only
def restore_snapshot(snapshot_id):
    """Makes the dashboard show an earlier publish again. It is saved as a new publish, so nothing
    is lost; the numbers on the review screen stay as they are."""
    old = db().get(IgniteSnapshot, snapshot_id) or abort(404)
    snap = IgniteSnapshot(published_at=now(), published_by=g.user.email, feed_json=old.feed_json,
                          restored_from=old.id, note=clean_text((request.get_json(silent=True) or {}).get("note"), 500))
    _show(snap)
    return jsonify(snap.to_dict()), 201


@api.get("/ignite/feed")
@ignite_only
def ignite_feed():
    """What the dashboard reads: the numbers of the last publish. Open without sign-in, as the
    dashboard is, so it holds block totals and nameless top-student rows only."""
    data = storage().get_or_none(FEED_KEY)
    if data is None:
        # No file yet (a publish from before the file was kept): take the last publish from the
        # database, and keep it as the file from now on.
        snap = _latest() or abort(404, "nothing has been published yet")
        data = _with_history(snap.feed_json)
        storage().put(FEED_KEY, data, "application/json")
    res = Response(data, mimetype="application/json")
    res.headers["Access-Control-Allow-Origin"] = "*"
    res.headers["Cache-Control"] = "public, max-age=60"
    return res
