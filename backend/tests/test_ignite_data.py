"""IGNITE: the programme, the team's sheet taken over, the review, Publish, restore and the feed."""
import io
import json

import pytest

from .conftest import ADMIN, TEACHER, make_app
from .test_api import make_state, make_test, upload
from .test_ignite import DETAILS, patch_sheet

OPENING = {"schools_reached": 12, "students_reached": 273, "hands_count": 40, "hands_avg": 3.0,
           "assessed": 10, "avg": 0.5, "girls": 0.4, "above50": 3, "above70": 2, "below50": 5}
SECRETS = ("Secretname", "778899", "9876501234", "Ramnagar", "Hidden High", "Pupil")


@pytest.fixture()
def app(tmp_path):
    return make_app(tmp_path, IGNITE_ENABLED=True)


def make_programme(client, opening=None):
    """Nashik with the block Dindori (and its opening numbers) and the block Yeola."""
    d = client.post("/api/ignite/districts", headers=ADMIN,
                    json={"state": "Maharashtra", "name": "Nashik", "blocks_count": 15, "total_schools": 3200,
                          "grade": "6 to 8", "total_students": 150000, "target_date": "2026-10-15"})
    assert d.status_code == 201, d.json
    blocks = [client.post("/api/ignite/blocks", headers=ADMIN, json={"district_id": d.json["id"], **body}).json
              for body in ({"name": "Dindori", "total_schools": 200, "selected_schools": 20, "student_target": 1500,
                            "opening": opening or {}}, {"name": "Yeola"})]
    return d.json, blocks


def submitted_batch(client, t, state, name="Ramnagar 7", activity=None, reached=None, **details):
    """A batch of one sheet, a girl, checked and submitted. activity: her activity score, and
    reached: the students in the hands-on challenge, both needed when the key takes an activity score."""
    b = client.post("/api/batches", headers=ADMIN,
                    json={"test_id": t["id"], "state_id": state["id"], "name": name, **{**DETAILS, **details}}).json
    s = upload(client, b["id"], "filled_sheet.jpg")[0]
    s = patch_sheet(client, s, confirm=True, hands_on_score=activity,
                    fields={"Name": "Asha Secretname", "Roll Number": "778899",
                            "Mobile Number": "9876501234", "gender": "Female"}).json
    if reached is not None:
        assert client.patch(f"/api/batches/{b['id']}", json={"students_reached": reached}, headers=ADMIN).status_code == 200
    r = client.post(f"/api/batches/{b['id']}/submit", headers=ADMIN)
    assert r.status_code == 200, r.json
    return b, s


def overview(client):
    r = client.get("/api/ignite/overview", headers=ADMIN)
    assert r.status_code == 200, r.json
    return r.json


def block_named(view, name):
    return next(b for d in view["districts"] for b in d["blocks"] if b["name"] == name)


def feed_rows(feed, tab="Nashik"):
    """The rows of a district's table as dicts by column name."""
    t = next(t for t in feed["blockTabs"] if t["tab"] == tab)
    return {row[t["header"].index("Block")]: dict(zip(t["header"], row)) for row in t["rows"]}


# ---- who may ----------------------------------------------------------------------------------

def test_switched_off_the_new_addresses_are_not_there(tmp_path):
    client = make_app(tmp_path).test_client()
    for path in ("/api/ignite/overview", "/api/ignite/feed", "/api/ignite/snapshots", "/api/ignite/preview"):
        assert client.get(path, headers=ADMIN).status_code == 404
    assert client.post("/api/ignite/publish", headers=ADMIN).status_code == 404
    assert client.post("/api/ignite/districts", json={"name": "Nashik"}, headers=ADMIN).status_code == 404


def test_only_admins_reach_the_review_and_the_feed_is_open(client):
    client.get("/api/me", headers=TEACHER)
    for call, path in ((client.get, "/api/ignite/overview"), (client.post, "/api/ignite/publish"),
                       (client.get, "/api/ignite/top"), (client.get, "/api/ignite/snapshots"),
                       (client.post, "/api/ignite/import"), (client.get, "/api/ignite/preview")):
        assert call(path).status_code == 401
        assert call(path, headers=TEACHER).status_code == 403
    assert client.get("/api/ignite/feed").status_code == 404          # open, and nothing published yet
    make_programme(client)
    assert client.post("/api/ignite/publish", headers=ADMIN).status_code == 201
    r = client.get("/api/ignite/feed")
    assert r.status_code == 200 and r.headers["Access-Control-Allow-Origin"] == "*"


# ---- the programme and the feed -----------------------------------------------------------------

def test_programme_and_opening_numbers_reach_the_feed(client):
    make_programme(client, OPENING)
    client.put("/api/ignite/settings", json={"hands_on_max": 25}, headers=ADMIN)
    assert client.post("/api/ignite/publish", json={"note": "First numbers"}, headers=ADMIN).status_code == 201
    feed = client.get("/api/ignite/feed").json

    state = feed["tabs"]["Districts"]
    assert state["tab"] == "Maharashtra"
    assert dict(zip(state["header"], state["rows"][0])) == {
        "Sr No.": 1, "State": "Maharashtra", "District": "Nashik", "No. of Blocks": 15, "No. of Total Schools": 3200,
        "Grade": "6 to 8", "No. of total students": 150000, "target date": "2026-10-15"}
    config = feed["tabs"]["Config"]
    assert config["header"][0] == "data_as_of" and config["rows"] == [["hands_on_max", 25.0]]

    rows = feed_rows(feed)
    assert list(rows) == ["Dindori", "Yeola"]
    dindori = rows["Dindori"]
    assert (dindori["Total Schools"], dindori["Schools selected for program implementation"],
            dindori["Total student count (standard)"]) == (200, 20, 1500)
    assert (dindori["No. of school (Outreach)"], dindori["No. of students (outreach)"]) == (12, 273)
    assert dindori["Assessment Status"] == "In Progress"
    assert (dindori["Number of students completed the assessment"], dindori["Average assessment score"]) == (10, 0.5)
    assert (dindori["Gender % Girls"], dindori["Hands on average score"]) == (0.4, 3.0)
    assert (dindori["Students Scored above 50%"], dindori["Students Scored above 70%"],
            dindori["Students Scored below 50%"]) == (3, 2, 5)
    # A block with no number yet: empty cells, which the dashboard reads as not there yet.
    assert rows["Yeola"]["Assessment Status"] == "Not started"
    assert rows["Yeola"]["Number of students completed the assessment"] == ""
    assert feed["topTabs"] == []


def test_a_submitted_batch_adds_to_its_block(client):
    make_programme(client, OPENING)
    t = make_test(client)
    client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 5}, headers=ADMIN)
    state = make_state(client)
    b, s = submitted_batch(client, t, state, activity=5, reached=1, block="dindori ")   # small letters: the same block
    # Test and activity together: (marks + 5) out of (50 + 5).
    share = (s["score"] + 5) / 55
    band = "above70" if share >= 0.7 else "above50" if share >= 0.5 else "below50"

    block = block_named(overview(client), "Dindori")
    assert [x["id"] for x in block["batches"]] == [b["id"]]
    assert block["batches"][0]["sheets"] == 1 and block["batches"][0]["average"] == round(share, 4)
    assert block["added"]["assessed"] == 1 and block["added"][band] == 1 and block["added"]["girls"] == 1
    shown = block["shown"]
    assert shown["assessed"] == 11 and shown["students_reached"] == 274 and shown["schools_reached"] == 13
    assert shown["avg"] == round((0.5 * 10 + share) / 11, 4)
    assert shown["girls"] == round((0.4 * 10 + 1) / 11, 4)
    assert shown["hands_count"] == 41 and shown["hands_avg"] == round((3.0 * 40 + 5) / 41, 2)
    assert shown[band] == OPENING[band] + 1
    assert block["published"] is None

    # The admin's own number of students reached is used in place of the number of sheets.
    client.patch(f"/api/batches/{b['id']}", json={"students_reached": 30}, headers=ADMIN)
    assert block_named(overview(client), "Dindori")["shown"]["students_reached"] == 303

    # Left out of the dashboard: the block is back at its opening numbers.
    assert client.put(f"/api/ignite/batches/{b['id']}", json={"left_out": True}, headers=ADMIN).json["left_out"]
    block = block_named(overview(client), "Dindori")
    assert block["shown"]["assessed"] == 10 and block["batches"][0]["left_out"] is True
    client.put(f"/api/ignite/batches/{b['id']}", json={"left_out": False}, headers=ADMIN)

    # A batch that is not submitted is in no number; it is listed as still being worked on.
    client.post(f"/api/batches/{b['id']}/reopen", headers=ADMIN)
    view = overview(client)
    assert block_named(view, "Dindori")["shown"]["assessed"] == 10
    assert [x["id"] for x in view["working"]] == [b["id"]]


def test_a_batch_that_matches_no_block_is_listed_and_counted_nowhere(client):
    make_programme(client, OPENING)
    t = make_test(client)
    state = make_state(client)
    b, _ = submitted_batch(client, t, state, block="Dindoree")
    view = overview(client)
    assert [x["id"] for x in view["unmatched"]] == [b["id"]]
    assert block_named(view, "Dindori")["shown"]["assessed"] == 10
    # Correct the place and it is counted.
    client.patch(f"/api/batches/{b['id']}", json={"block": "Dindori"}, headers=ADMIN)
    view = overview(client)
    assert view["unmatched"] == [] and block_named(view, "Dindori")["shown"]["assessed"] == 11


def test_an_admins_own_figure_wins_and_can_be_taken_away(client):
    _, blocks = make_programme(client, OPENING)
    r = client.patch(f"/api/ignite/blocks/{blocks[0]['id']}", headers=ADMIN,
                     json={"status": "Completed", "overrides": {"students_reached": {"value": 300, "note": "Counted on the visit"}}})
    assert r.status_code == 200
    block = block_named(overview(client), "Dindori")
    assert block["shown"]["students_reached"] == 300 and block["status_shown"] == "Completed"
    assert block["overrides"]["students_reached"]["note"] == "Counted on the visit"
    assert block["overrides"]["students_reached"]["by"] == "admin@example.org"
    client.patch(f"/api/ignite/blocks/{blocks[0]['id']}", headers=ADMIN, json={"overrides": {"students_reached": None}})
    block = block_named(overview(client), "Dindori")
    assert block["shown"]["students_reached"] == 273 and block["overrides"] == {}


def test_what_is_typed_is_checked(client):
    d, blocks = make_programme(client)
    assert client.post("/api/ignite/districts", json={"name": " nashik"}, headers=ADMIN).status_code == 400
    assert client.post("/api/ignite/districts", json={"name": ""}, headers=ADMIN).status_code == 400
    assert client.post("/api/ignite/blocks", json={"district_id": d["id"], "name": "yeola"}, headers=ADMIN).status_code == 400
    block = f"/api/ignite/blocks/{blocks[0]['id']}"
    assert client.patch(block, json={"total_schools": -1}, headers=ADMIN).status_code == 400
    assert client.patch(block, json={"opening": {"avg": 1.5}}, headers=ADMIN).status_code == 400
    assert client.patch(block, json={"opening": {"assessed": 2.5}}, headers=ADMIN).status_code == 400
    assert client.patch(block, json={"opening": {"names": 3}}, headers=ADMIN).status_code == 400
    assert client.put("/api/ignite/settings", json={"hands_on_max": 0}, headers=ADMIN).status_code == 400
    assert client.post("/api/ignite/publish", headers=ADMIN).status_code == 201
    assert client.delete(f"/api/ignite/districts/{d['id']}", headers=ADMIN).status_code == 204
    assert overview(client)["districts"] == []
    assert client.post("/api/ignite/publish", headers=ADMIN).status_code == 400    # nothing to show


# ---- Publish and restore ------------------------------------------------------------------------

def test_publish_keeps_each_set_of_numbers_and_an_earlier_one_can_be_restored(client):
    _, blocks = make_programme(client, OPENING)
    assert overview(client)["changed"] is True and overview(client)["last_publish"] is None
    first = client.post("/api/ignite/publish", json={"note": "Opening numbers"}, headers=ADMIN).json
    view = overview(client)
    assert view["changed"] is False and view["last_publish"]["id"] == first["id"]
    assert block_named(view, "Dindori")["published"]["assessed"] == 10

    # A change on the review screen reaches the dashboard only with the next publish.
    client.patch(f"/api/ignite/blocks/{blocks[0]['id']}", headers=ADMIN, json={"opening": {"assessed": 50}})
    view = overview(client)
    assert view["changed"] is True
    assert block_named(view, "Dindori")["shown"]["assessed"] == 50
    assert block_named(view, "Dindori")["published"]["assessed"] == 10
    assert feed_rows(client.get("/api/ignite/feed").json)["Dindori"]["Number of students completed the assessment"] == 10
    second = client.post("/api/ignite/publish", headers=ADMIN).json
    assert feed_rows(client.get("/api/ignite/feed").json)["Dindori"]["Number of students completed the assessment"] == 50

    restored = client.post(f"/api/ignite/snapshots/{first['id']}/restore", headers=ADMIN)
    assert restored.status_code == 201 and restored.json["restored_from"] == first["id"]
    assert feed_rows(client.get("/api/ignite/feed").json)["Dindori"]["Number of students completed the assessment"] == 10
    listed = client.get("/api/ignite/snapshots", headers=ADMIN).json
    assert [s["id"] for s in listed] == [restored.json["id"], second["id"], first["id"]]
    assert listed[2]["note"] == "Opening numbers" and listed[2]["published_by"] == "admin@example.org"
    # The working numbers did not go back: they differ from what the dashboard shows now.
    assert overview(client)["changed"] is True


def test_the_dashboard_reads_a_file_and_never_the_database(client, app):
    make_programme(client, OPENING)
    client.post("/api/ignite/publish", headers=ADMIN)
    store = app.extensions["storage"]
    served = client.get("/api/ignite/feed").data
    assert store.get_or_none("ignite/feed.json") == served
    # What is in the file is what is served.
    store.put("ignite/feed.json", b'{"from": "the file"}')
    assert client.get("/api/ignite/feed").json == {"from": "the file"}
    # Without the file (a publish from before it was kept) the last publish comes from the
    # database once, and the file is made again.
    (store.root / "ignite" / "feed.json").unlink()
    assert client.get("/api/ignite/feed").data == served
    assert store.get_or_none("ignite/feed.json") == served


# ---- top students and privacy -------------------------------------------------------------------

def test_marked_top_students_are_published_without_names(client, tmp_path):
    d, _ = make_programme(client, OPENING)
    skills = {f"q{i}": "Logical & Computational Thinking" if i <= 25 else "Programming & Debugging" for i in range(1, 51)}
    t = make_test(client)
    client.put(f"/api/tests/{t['id']}/ignite", json={"skill_map": skills}, headers=ADMIN)
    b, s = submitted_batch(client, t, make_state(client))

    listed = client.get(f"/api/ignite/top?district_id={d['id']}", headers=ADMIN).json
    assert [x["id"] for x in listed["students"]] == [s["id"]]
    student = listed["students"][0]
    assert student["name"] == "Asha Secretname" and student["block"] == "Dindori" and student["gender"] == "F"
    assert student["top5"] is False and set(student["skills"]) == set(skills.values())

    marked = client.put(f"/api/ignite/top/{s['id']}", json={"top1": True}, headers=ADMIN).json
    assert marked == {"id": s["id"], "top5": True, "top1": True}        # top 1% is in the top 5% too
    assert overview(client)["districts"][0]["top_marked"] == 1
    client.post("/api/ignite/publish", headers=ADMIN)
    r = client.get("/api/ignite/feed")
    top = r.json["topTabs"][0]
    assert top["tab"] == "Top students_Nashik"
    row = dict(zip(top["header"], top["rows"][0]))
    assert row["Gender"] == "F" and row["Block Name"] == "Dindori" and row["Total Percent"] == round(s["score"] / 50, 4)
    assert row["Top 5 %"] == "Yes" and row["Top 1 %"] == "Yes"
    assert 0 <= row["Logical & Computational Thinking"] <= 1 and 0 <= row["Programming & Debugging"] <= 1
    assert not any(h.lower() in ("name", "school", "school name", "roll number", "mobile number") for h in top["header"])
    # Nothing that says who the student is, or which school, is in what the dashboard reads.
    text = r.get_data(as_text=True) + json.dumps(client.get("/api/ignite/preview", headers=ADMIN).json)
    assert not [word for word in SECRETS if word in text]

    # Unmarking top 5% takes top 1% away as well, and the student leaves the dashboard at the next publish.
    assert client.put(f"/api/ignite/top/{s['id']}", json={"top5": False}, headers=ADMIN).json["top1"] is False
    client.post("/api/ignite/publish", headers=ADMIN)
    assert client.get("/api/ignite/feed").json["topTabs"] == []


# ---- the team's sheet -----------------------------------------------------------------------------

def team_sheet():
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Maharashtra"
    ws.append(["Sr No.", "State", "District", "No. of Blocks", "No. of Total Schools", "Grade", "No. of total students",
               "target date"])
    ws.append([1, "Maharashtra", "Nashik", 15, 3200, "6 to 8", 150000, "15/10/2026"])
    ws.append([2, "Maharashtra", "Sangli", 10, 1700, "6 to 8", 90000, None])
    ws = wb.create_sheet("Nashik")
    ws.append(["Sr No.", "State", "District", "Block", "Total Schools", "Schools selected for program implementation",
               "Total student count (standard)", "No. of school (Outreach)", "No. of students (outreach)",
               "Assessment Status", "Completion rate", "No. of students completed hands on activity",
               "hands on selection based on total", "Hands on average score",
               "Number of students completed the assessment", "Average assessment score",
               "% of students participated in assessment", "Gender\n% Girls", "Students Scored above 50%",
               "Students Scored above 70%", "Students Scored below 50%"])
    ws.append([1, "Maharashtra", "Nashik", "Dindori", 200, 20, 1500, 12, 273, "Completed", 0.6, 40, 50, 3.4, 109, 0.52,
               0.4, 0.45, 30, 12, 67])
    ws.append([2, "Maharashtra", "Nashik", "Yeola", 180, 18, 1200, "NA", "NA", "Not started", None, "NA", None,
               "yet not received", "Not done", "NA", None, "NA'", None, None, None])
    ws.append([None, None, None, None, 380, 38, 2700, 12, 273, None, None, 40, None, None, 109, None, None, None, 30, 12, 67])
    ws = wb.create_sheet("Top students_Nashik")
    ws.append(["Sr No.", "Name", "Gender", "School Name", "Block Name", "score", "Total Percent",
               "Logical & Computational Thinking", "Programming & Debugging", "Performance band", "Top 5 %",
               "Data source", "Top 1 %", "Remark"])
    ws.append([1, "Asha Secretname", "F", "Hidden High School", "Dindori", 23, 0.92, 1, 0.8, "Above 70%", "Top 5%",
               "scanner", "Top 1%", None])
    ws.append([2, "Other Pupil", "M", "Hidden High School", "Yeola", 18, 0.72, 0.6, 0.4, "Above 70%", "Top 5%",
               "scanner", None, "checked by Pupil's teacher"])
    ws.append([3, "Third Pupil", "M", "Hidden High School", "Yeola", 15, 0.6, 0.6, 0.4, "Above 50%", None, "scanner",
               None, None])
    ws = wb.create_sheet("Top40_students")
    ws.append(["Name", "School Name", "Block", "score"])
    ws.append(["Fourth Pupil", "Hidden High School", "Dindori", 22])
    ws = wb.create_sheet("Config")
    ws.append(["hands_on_max", 25])
    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out


def import_sheet(client):
    return client.post("/api/ignite/import", headers=ADMIN, content_type="multipart/form-data",
                       data={"file": (team_sheet(), "Data for dashboard.xlsx")})


def test_the_teams_sheet_is_taken_over_without_names(client, tmp_path):
    r = import_sheet(client)
    assert r.status_code == 200 and r.json == {"districts": 2, "blocks": 2, "top_students": 2, "hands_on_max": 25.0}
    view = overview(client)
    assert view["settings"] == {"hands_on_max": 25.0}
    assert [(d["name"], d["blocks_count"], d["target_date"], len(d["blocks"])) for d in view["districts"]] == [
        ("Nashik", 15, "2026-10-15", 2), ("Sangli", 10, None, 0)]
    assert view["districts"][0]["top_imported"] == 2
    dindori = block_named(view, "Dindori")
    assert (dindori["total_schools"], dindori["selected_schools"], dindori["student_target"]) == (200, 20, 1500)
    assert dindori["status"] == "Completed"
    assert dindori["opening"] == {"schools_reached": 12, "students_reached": 273, "hands_count": 40, "hands_avg": 3.4,
                                  "assessed": 109, "avg": 0.52, "girls": 0.45, "above50": 30, "above70": 12,
                                  "below50": 67}
    yeola = block_named(view, "Yeola")
    assert yeola["status"] == "Not started" and set(yeola["opening"].values()) == {None}

    client.post("/api/ignite/publish", headers=ADMIN)
    r = client.get("/api/ignite/feed")
    top = r.json["topTabs"][0]
    assert top["header"] == ["Gender", "Block Name", "Total Percent", "Logical & Computational Thinking",
                             "Programming & Debugging", "Performance band", "Top 5 %", "Top 1 %"]
    assert top["rows"] == [["F", "Dindori", 0.92, 1.0, 0.8, "Above 70%", "Yes", "Yes"],
                           ["M", "Yeola", 0.72, 0.6, 0.4, "Above 70%", "Yes", ""]]
    # Sangli has no block tab in the file: it is in the state table only.
    assert [t["tab"] for t in r.json["blockTabs"]] == ["Nashik"]
    # No name and no school: not in the feed, and not in the database either.
    stored = (tmp_path / "test.db").read_bytes()
    assert not [word for word in SECRETS if word in r.get_data(as_text=True) or word.encode() in stored]

    # Taking the sheet over again changes the figures of the file and nothing else.
    block_id = dindori["id"]
    client.patch(f"/api/ignite/blocks/{block_id}", headers=ADMIN,
                 json={"opening": {"assessed": 1}, "overrides": {"avg": {"value": 0.6, "note": "Rechecked"}}})
    assert import_sheet(client).status_code == 200
    view = overview(client)
    dindori = block_named(view, "Dindori")
    assert dindori["id"] == block_id and dindori["opening"]["assessed"] == 109 and dindori["shown"]["avg"] == 0.6
    assert len(view["districts"]) == 2 and view["districts"][0]["top_imported"] == 2


def test_a_file_that_is_not_the_sheet_is_refused(client):
    r = client.post("/api/ignite/import", headers=ADMIN, content_type="multipart/form-data",
                    data={"file": (io.BytesIO(b"not a workbook"), "notes.xlsx")})
    assert r.status_code == 400 and "could not be read" in r.json["error"]
    assert client.post("/api/ignite/import", headers=ADMIN).status_code == 400


def test_teachers_are_offered_the_programmes_spellings(client):
    make_programme(client)
    state = make_state(client)
    places = client.get("/api/places", headers=ADMIN).json["places"]
    assert {"state_id": state["id"], "district": "Nashik", "block": "Dindori", "school": "", "status": ""} in places
    assert {"state_id": state["id"], "district": "Nashik", "block": "Yeola", "school": "", "status": ""} in places


def test_a_students_percent_is_test_and_activity_together(client):
    """Answer 7: the block average, the score groups and the top students use (test + activity)
    out of (most marks + most activity). The skills stay the test's."""
    make_programme(client)
    t = make_test(client)
    client.put(f"/api/tests/{t['id']}/ignite", json={"hands_on_max": 5}, headers=ADMIN)
    d = overview(client)["districts"][0]
    _, s = submitted_batch(client, t, make_state(client), activity=4, reached=2)
    combined = round((s["score"] + 4) / 55, 4)
    block = block_named(overview(client), "Dindori")
    assert block["batches"][0]["average"] == combined and block["batches"][0]["students_reached"] == 2

    top = client.get("/api/ignite/top", query_string={"district_id": d["id"]}, headers=ADMIN).json["students"]
    assert top[0]["percent"] == combined and top[0]["hands_on_score"] == 4 and top[0]["hands_on_max"] == 5
    client.put(f"/api/ignite/top/{s['id']}", json={"top5": True}, headers=ADMIN)
    feed = client.get("/api/ignite/preview", headers=ADMIN).json
    assert feed["topTabs"][0]["rows"][0][2] == combined


def test_a_block_marked_completed_flags_new_batches(client):
    """Answers 18 and 21: no more papers come for a Completed block. A batch for one is shown, not
    silently added: the form warns (the status is in the places) and the review flags it."""
    _, blocks = make_programme(client)
    client.patch(f"/api/ignite/blocks/{blocks[0]['id']}", json={"status": "Completed"}, headers=ADMIN)
    state = make_state(client)
    places = client.get("/api/places", headers=ADMIN).json["places"]
    assert {"state_id": state["id"], "district": "Nashik", "block": "Dindori", "school": "",
            "status": "Completed"} in places
    submitted_batch(client, make_test(client), state)
    assert block_named(overview(client), "Dindori")["batches"][0]["block_completed"] is True


def old_sheet(block="Devla", score=17, percent=0.7391):
    """A sheet with a block spelt "Devla" and a top student marked out of 23 by mistake."""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Nashik"
    ws.append(["Sr No.", "State", "District", "Block", "Total Schools", "Assessment Status",
               "Number of students completed the assessment"])
    ws.append([1, "Maharashtra", "Nashik", block, 100, "In Progress", 77])
    ws = wb.create_sheet("Top students_Nashik")
    ws.append(["Sr No.", "Name", "Gender", "School Name", "Block Name", "score", "Total Percent",
               "Performance band", "Top 5 %", "Top 1 %"])
    ws.append([1, "Asha Secretname", "F", "Hidden High School", block, score, percent, "Above 70%", "Yes", None])
    ws.append([2, "Other Pupil", "M", "Hidden High School", block, 22, 0.88, "Above 70%", "Yes", None])
    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out


def import_old_sheet(client):
    r = client.post("/api/ignite/import", headers=ADMIN, content_type="multipart/form-data",
                    data={"file": (old_sheet(), "Data for dashboard.xlsx")})
    assert r.status_code == 200, r.json


def test_an_admins_activity_scale_stays_when_the_sheet_is_taken_over_again(client):
    """Answer 9: the activity is out of 5, while the sheet's Config says 25."""
    assert client.put("/api/ignite/settings", json={"hands_on_max": 5}, headers=ADMIN).status_code == 200
    assert import_sheet(client).status_code == 200
    assert overview(client)["settings"] == {"hands_on_max": 5.0}


def test_old_top_percents_are_out_of_25_and_devla_is_deola(client):
    """Answer 15: every paper had 25 questions; 17 marks is 68%, not 74% (out of 23), so the band
    moves too. Answer 17: the block is Deola, whatever the sheet calls it."""
    import_old_sheet(client)
    assert [b["name"] for b in overview(client)["districts"][0]["blocks"]] == ["Deola"]
    tab = client.get("/api/ignite/preview", headers=ADMIN).json["topTabs"][0]
    rows = [dict(zip(tab["header"], row)) for row in tab["rows"]]
    assert [(x["Block Name"], x["Total Percent"], x["Performance band"]) for x in rows] == [
        ("Deola", 0.68, "Above 50%"), ("Deola", 0.88, "Above 70%")]


def test_a_block_already_spelt_devla_takes_the_name_deola(client):
    """A block made as "Devla" keeps its batches when the import calls it Deola; a batch typed
    "Devla" counts for Deola."""
    d = client.post("/api/ignite/districts", headers=ADMIN, json={"state": "Maharashtra", "name": "Nashik"}).json
    devla = client.post("/api/ignite/blocks", headers=ADMIN, json={"district_id": d["id"], "name": "Devla"}).json
    submitted_batch(client, make_test(client), make_state(client), block="Devla")
    import_old_sheet(client)
    view = overview(client)
    blocks = view["districts"][0]["blocks"]
    assert [(b["id"], b["name"]) for b in blocks] == [(devla["id"], "Deola")]
    assert len(blocks[0]["batches"]) == 1 and view["unmatched"] == []


def test_a_block_still_stored_as_devla_is_published_as_deola(client):
    """Before the sheet is imported again the block keeps its old name in the app, but the
    dashboard gets Deola, the same name its top students carry."""
    d = client.post("/api/ignite/districts", headers=ADMIN, json={"state": "Maharashtra", "name": "Nashik"}).json
    client.post("/api/ignite/blocks", headers=ADMIN, json={"district_id": d["id"], "name": "Devla"})
    feed = client.get("/api/ignite/preview", headers=ADMIN).json
    assert list(feed_rows(feed)) == ["Deola"]


# ---- many schools at one session (answers 2 and 3) ----------------------------------------------

def test_a_batch_has_many_schools_and_each_school_counts_once_in_its_block(client):
    make_programme(client, OPENING)                       # Dindori: 12 schools before the app
    t = make_test(client)
    state = make_state(client)
    first, _ = submitted_batch(client, t, state, schools=["ZP School Ramnagar", "Hidden High", "hidden  high"])
    assert first["schools"] == ["ZP School Ramnagar", "Hidden High"] and first["school"] == "ZP School Ramnagar, Hidden High"
    # A second session at Ramnagar (spelt another way) and at a new school: Ramnagar is not counted again.
    second, _ = submitted_batch(client, t, state, name="Central place 2", schools=["Z.P. School Ramnagar", "New Hope School"])
    block = block_named(overview(client), "Dindori")
    assert block["added"]["schools_reached"] == 3 and block["shown"]["schools_reached"] == 15
    assert [x["schools"] for x in block["batches"]] == [first["schools"], second["schools"]]

    # The team's list of the schools it had already counted: those add no school now.
    r = client.patch(f"/api/ignite/blocks/{block['id']}", headers=ADMIN,
                     json={"schools_counted": "Hidden High\n\n new hope school \nHidden High\n"})
    assert r.status_code == 200, r.json
    block = block_named(overview(client), "Dindori")
    assert block["schools_counted"] == ["Hidden High", "new hope school"]
    assert block["added"]["schools_reached"] == 1 and block["shown"]["schools_reached"] == 13
    assert block["batches"][0]["schools_counted_before"] == ["Hidden High"]
    assert block["batches"][1]["schools_counted_before"] == ["New Hope School"]

    # Teachers are offered every school of the block: from the batches and from the team's list.
    places = client.get("/api/places", headers=ADMIN).json["places"]
    schools = {p["school"] for p in places if p["block"] == "Dindori"}
    assert {"ZP School Ramnagar", "Hidden High", "Z.P. School Ramnagar", "New Hope School", "new hope school"} <= schools

    # No school reaches the dashboard.
    client.post("/api/ignite/publish", headers=ADMIN)
    served = client.get("/api/ignite/feed").data.decode("utf-8").lower()
    assert not any(name in served for name in ("ramnagar", "hidden high", "new hope"))


def test_more_sheets_for_a_batch_add_their_schools(client):
    t = make_test(client)
    state = make_state(client)
    body = {"test_id": t["id"], "state_id": state["id"], "name": "Central place", "district": "Nashik", "block": "Dindori"}
    b = client.post("/api/batches", headers=ADMIN, json={**body, "schools": ["School A"]}).json
    assert b["schools"] == ["School A"]
    # The same batch again, with sheets from other schools: they are added, nothing is wiped.
    again = client.post("/api/batches", headers=ADMIN, json={**body, "schools": ["School B", "school a"]})
    assert again.status_code == 200 and again.json["schools"] == ["School A", "School B"]
    # An older screen sends one "school": it is added the same way.
    assert client.post("/api/batches", headers=ADMIN, json={**body, "school": "School C"}).json["schools"] == \
        ["School A", "School B", "School C"]
    assert client.post("/api/batches", headers=ADMIN, json={**body, "schools": []}).json["schools"] == \
        ["School A", "School B", "School C"]
    # The batch page sets the whole list: a school can be taken off.
    r = client.patch(f"/api/batches/{b['id']}", headers=ADMIN, json={"schools": ["School B"]})
    assert r.status_code == 200 and r.json["schools"] == ["School B"] and r.json["school"] == "School B"
    assert client.patch(f"/api/batches/{b['id']}", headers=ADMIN, json={"schools": "not a list"}).json["schools"] == \
        ["not a list"]
    assert client.patch(f"/api/batches/{b['id']}", headers=ADMIN, json={"schools": 7}).status_code == 400


def test_one_paper_gets_one_school_never_a_list():
    from types import SimpleNamespace
    from server.ignite import school_from_file, school_of
    from server.models import Batch

    paper = SimpleNamespace(source_name="Asha_G7_Hidden High_Dindori.pdf")
    assert school_from_file(paper.source_name) == "Hidden High"
    assert school_from_file("scan 0012.pdf") == ""
    one = Batch(school="ZP School Ramnagar")                       # a batch from before the list
    assert school_of(paper, one) == "ZP School Ramnagar"
    many = Batch(schools_json=json.dumps(["ZP School Ramnagar", "hidden high"]), school="ZP School Ramnagar, hidden high")
    assert school_of(paper, many) == "hidden high"
    assert school_of(SimpleNamespace(source_name="all papers.pdf"), many) == ""
    assert school_of(SimpleNamespace(source_name="Asha_G7_Other School_Dindori.pdf"), many) == ""
    assert school_of(paper, Batch()) == ""


# ---- the weekly graph (answer 23) ---------------------------------------------------------------

def history(client):
    tab = client.get("/api/ignite/feed").json["tabs"]["History"]
    assert tab["header"][:4] == ["Week", "District", "Schools reached", "Students reached"]
    return [dict(zip(tab["header"], row)) for row in tab["rows"]]


def test_each_publish_keeps_the_weeks_totals_for_the_graph(client, app):
    from datetime import date, timedelta
    from server.ignite import INDIA
    from server.models import IgniteDay, now

    _, blocks = make_programme(client, OPENING)
    first = client.post("/api/ignite/publish", headers=ADMIN).json
    today = now().astimezone(INDIA).date()
    assert history(client) == [{"Week": today.isoformat(), "District": "Nashik", "Schools reached": 12,
                                "Students reached": 273, "Students assessed": 10}]
    # A second publish on the same day replaces that day's totals.
    client.patch(f"/api/ignite/blocks/{blocks[0]['id']}", headers=ADMIN, json={"opening": {"assessed": 50}})
    client.post("/api/ignite/publish", headers=ADMIN)
    assert [r["Students assessed"] for r in history(client)] == [50]
    # The publishes of earlier weeks: the last day of a week stands for it.
    with app.app_context():
        session = app.extensions["db_session"]
        last_week = today - timedelta(days=7)
        monday = last_week - timedelta(days=last_week.weekday())
        for day, schools in ((monday, 5), (monday + timedelta(days=2), 8), (monday - timedelta(days=1), 2)):
            session.add(IgniteDay(day=day, district="Nashik", schools_reached=schools, students_reached=100,
                                  assessed=9, published_at=now()))
        session.add(IgniteDay(day=monday, district="Thane", published_at=now()))     # no numbers yet: left out
        session.commit()
    # A restore is a publish: today shows the restored numbers, and no week is lost.
    client.post(f"/api/ignite/snapshots/{first['id']}/restore", headers=ADMIN)
    rows = history(client)
    assert [(r["Week"], r["Schools reached"], r["Students assessed"]) for r in rows] == [
        ((monday - timedelta(days=1)).isoformat(), 2, 9), ((monday + timedelta(days=2)).isoformat(), 8, 9),
        (today.isoformat(), 12, 10)]
    # The weeks do not make the review screen think the numbers changed.
    assert overview(client)["changed"] is True          # the working numbers differ from the restored ones
    client.post("/api/ignite/publish", headers=ADMIN)
    assert overview(client)["changed"] is False


def test_a_marathi_school_name_is_kept_and_stored_as_plain_text():
    from server.ignite import clean_schools, set_schools
    from server.models import Batch

    b = Batch()
    set_schools(b, clean_schools(["जि.प. शाळा रामनगर", "जिप शाळा रामनगर", "जि.प. शाळा रमनगर"]))
    # The SQL Server column is not Unicode: the list is kept as plain text, and reads back the same.
    assert b.schools_json.isascii()
    assert b.schools == ["जि.प. शाळा रामनगर", "जि.प. शाळा रमनगर"]
