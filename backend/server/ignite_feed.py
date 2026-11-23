"""IGNITE: the numbers the dashboard shows. They are worked out from three things: the programme
(districts, blocks and the figures an admin types), the opening numbers (what the dashboard showed
before this app fed it, taken once from the team's sheet) and the batches teachers have submitted.

build_feed() gives them in the shape the dashboard reads: the state table, one table per district
with a row per block, one table of top students per district and a few settings. A name, a roll
number, a mobile number or a school is never put in it.

No routes here: they are in ignite_data_api.py."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy.orm import joinedload, selectinload

from .ignite import INDIA, school_key, skill_scores
from .models import Batch, IgniteBlock, IgniteDistrict, IgniteSetting, Sheet

# The figures of a block that come from the field. Each is its opening number plus what the
# submitted batches add, unless an admin typed another figure over it.
COUNTS = ("schools_reached", "students_reached", "hands_count", "assessed", "above50", "above70", "below50")
SHARES = ("avg", "girls")                         # from 0 to 1
FIGURES = COUNTS + SHARES + ("hands_avg",)

# The columns of a district's table, as the dashboard reads them, and where each comes from.
PROGRAMME_COLUMNS = (("Total Schools", "total_schools"),
                     ("Schools selected for program implementation", "selected_schools"),
                     ("Total student count (standard)", "student_target"))
BLOCK_COLUMNS = (("No. of school (Outreach)", "schools_reached"),
                 ("No. of students (outreach)", "students_reached"),
                 ("Assessment Status", "status"),
                 ("No. of students completed hands on activity", "hands_count"),
                 ("Hands on average score", "hands_avg"),
                 ("Number of students completed the assessment", "assessed"),
                 ("Average assessment score", "avg"),
                 ("Gender % Girls", "girls"),
                 ("Students Scored above 50%", "above50"),
                 ("Students Scored above 70%", "above70"),
                 ("Students Scored below 50%", "below50"))
BLOCK_HEADER = ["Sr No.", "State", "District", "Block"] + [h for h, _ in PROGRAMME_COLUMNS + BLOCK_COLUMNS]
STATE_HEADER = ["Sr No.", "State", "District", "No. of Blocks", "No. of Total Schools", "Grade",
                "No. of total students", "target date"]
# The weekly graph (answer 23): one row per district per week, the totals of the last publish of
# that week, dated with the day of that publish. The day a week ends is the team's to say
# (question 8); until then a week ends on Sunday (Monday is 0).
WEEK_ENDS_ON = 6
HISTORY_HEADER = ["Week", "District", "Schools reached", "Students reached", "Students assessed"]
HISTORY_COLUMNS = (("schools_reached", "No. of school (Outreach)"), ("students_reached", "No. of students (outreach)"),
                   ("assessed", "Number of students completed the assessment"))

_SHEET_COLUMNS = (Sheet.status, Sheet.left_out, Sheet.score, Sheet.fields_json, Sheet.answers_json,
                  Sheet.hands_on_score, Sheet.top5, Sheet.top1)


def key(text) -> str:
    """A name for comparing: "  Nashik " and "nashik" are the same place."""
    return " ".join(str(text or "").split()).lower()


# Blocks the team's sheet spells another way, and the name the programme uses (answer 17: Deola).
BLOCK_NAMES = {"devla": "Deola"}


def block_name(name):
    """A block's name as the programme spells it: "Devla" is "Deola"."""
    return BLOCK_NAMES.get(key(name), name)


def place_key(text) -> str:
    """A block's name for comparing, with the other spellings of a block made one."""
    return key(block_name(text))


def share_of(score: Optional[float], most: float) -> float:
    """A score as a share of the most it can be, from 0 to 1."""
    return min(1.0, max(0.0, (score or 0) / most)) if most else 0.0


def band_of(share: float) -> str:
    return "Above 70%" if share >= 0.7 else "Above 50%" if share >= 0.5 else "Below 50%"


def most_marks(test) -> float:
    return len(test.answer_key) * test.marks_correct


def counted(batch: Batch) -> List[Sheet]:
    """The sheets of a batch that count: read, and not left out."""
    return [s for s in batch.sheets if not s.left_out and s.status == "ok" and s.score is not None]


def percent_of(sheet: Sheet, test) -> float:
    """A student's percent, from 0 to 1: the test marks and the activity score together, out of
    both maximums, (18 + 4) / (25 + 5) (the team's answers 7 and 9). The block average, the three
    score groups and the top students use it. With no activity score on the answer key or on the
    sheet (a batch from before Submit asked for one), the test alone. The skills stay test only."""
    most = most_marks(test)
    if test.hands_on_max and sheet.hands_on_score is not None:
        return share_of((sheet.score or 0) + sheet.hands_on_score, most + test.hands_on_max)
    return share_of(sheet.score, most)


def tally(batch: Batch) -> dict:
    """What one batch adds: the counts, and the sums the averages are worked out from."""
    sheets = counted(batch)
    shares = [percent_of(s, batch.test) for s in sheets]
    genders = [(s.fields.get("gender") or "").strip().lower() for s in sheets]
    hands = [s.hands_on_score for s in sheets if s.hands_on_score is not None]
    kept = sum(1 for s in batch.sheets if not s.left_out)
    return {"sheets": len(sheets), "share_sum": sum(shares),
            "girls": genders.count("female"), "gender_known": genders.count("female") + genders.count("male"),
            "hands_count": len(hands), "hands_sum": sum(hands),
            "above70": sum(1 for p in shares if p >= 0.7),
            "above50": sum(1 for p in shares if 0.5 <= p < 0.7),
            "below50": sum(1 for p in shares if p < 0.5),
            "students_reached": batch.students_reached if batch.students_reached is not None else kept,
            "schools": {school_key(name) for name in batch.schools} - {""}}


def new_schools(tallies: List[dict], counted_before=frozenset()) -> set:
    """The schools the batches add: each school once, however many batches were at it, and
    none the team's sheet had already counted (the team's answer 2)."""
    return set().union(*(t["schools"] for t in tallies)) - set(counted_before)


def combine(opening: dict, tallies: List[dict], counted_before=frozenset()) -> dict:
    """The opening numbers of a block plus what its batches add. A figure with no opening number
    and nothing added stays None: the dashboard then shows it as not there yet. counted_before:
    the schools already in the opening number, as school_key()s."""
    def added(k):
        return sum(t[k] for t in tallies)

    def count(name, extra, known=False):
        base = opening.get(name)
        return None if base is None and not extra and not known else int((base or 0) + extra)

    def mean(name, weight_name, extra_sum, extra_n):
        base, weight = opening.get(name), opening.get(weight_name) or 0
        if not extra_n:
            return base
        if base is None or not weight:
            return extra_sum / extra_n
        return (base * weight + extra_sum) / (weight + extra_n)

    sheets = added("sheets")
    return {
        "schools_reached": count("schools_reached", len(new_schools(tallies, counted_before))),
        "students_reached": count("students_reached", added("students_reached")),
        "hands_count": count("hands_count", added("hands_count")),
        "hands_avg": mean("hands_avg", "hands_count", added("hands_sum"), added("hands_count")),
        "assessed": count("assessed", sheets),
        "avg": mean("avg", "assessed", added("share_sum"), sheets),
        "girls": mean("girls", "assessed", added("girls"), added("gender_known")),
        # With sheets added, a band nobody is in is 0, not unknown.
        "above50": count("above50", added("above50"), known=sheets > 0),
        "above70": count("above70", added("above70"), known=sheets > 0),
        "below50": count("below50", added("below50"), known=sheets > 0),
    }


def tidy(name: str, value):
    """A figure as it is published: whole numbers for counts, a few decimals for the rest."""
    if value is None or isinstance(value, str):
        return value
    if name in COUNTS:
        return int(round(value))
    return round(float(value), 2 if name == "hands_avg" else 4)


def hands_on_max(session) -> Optional[float]:
    row = session.get(IgniteSetting, "hands_on_max")
    try:
        return float(row.value) if row and row.value else None
    except ValueError:
        return None


def work_out(session) -> dict:
    """Every district with its blocks, and for each block: the submitted batches filed under it,
    what they add, the figures (opening plus added) and the figures as shown (an admin's own
    figure wins). A submitted batch whose district and block match no block of the programme is
    in "unmatched": it is in no number until its place is corrected or the block is added."""
    districts = (session.query(IgniteDistrict)
                 .options(selectinload(IgniteDistrict.blocks).selectinload(IgniteBlock.schools),
                          selectinload(IgniteDistrict.top_rows))
                 .order_by(IgniteDistrict.position, IgniteDistrict.name).all())
    where: Dict[tuple, list] = {}
    for d in districts:
        for b in d.blocks:
            where.setdefault((key(d.name), place_key(b.name)), []).append(b)
    submitted = (session.query(Batch).filter(Batch.submitted_at.isnot(None))
                 .options(selectinload(Batch.sheets).load_only(*_SHEET_COLUMNS), joinedload(Batch.test),
                          joinedload(Batch.state))
                 .order_by(Batch.submitted_at).all())
    batches_of: Dict[str, list] = {}
    unmatched = []
    for batch in submitted:
        state = key(batch.state.name) if batch.state else ""
        found = [b for b in where.get((key(batch.district), place_key(batch.block)), [])
                 if not state or not key(b.district.state) or key(b.district.state) == state]
        if found:
            batches_of.setdefault(found[0].id, []).append(batch)
        else:
            unmatched.append(batch)
    out = []
    for d in districts:
        rows = []
        for b in d.blocks:
            batches = batches_of.get(b.id, [])
            tallies = [tally(x) for x in batches if not x.dashboard_left_out]
            before = {school_key(s.name) for s in b.schools}
            figures = combine(b.opening, tallies, before)
            shown = {**figures, **{k: v.get("value") for k, v in b.overrides.items() if k in FIGURES}}
            shown = {k: tidy(k, v) for k, v in shown.items()}
            rows.append({"block": b, "batches": batches, "added": combine({}, tallies, before), "figures": figures,
                         "shown": shown,
                         "status": b.status or ("In Progress" if shown.get("assessed") else "Not started")})
        out.append({"district": d, "blocks": rows})
    return {"districts": out, "unmatched": unmatched}


def top_sheet(sheet: Sheet, batch: Batch, block_name: str) -> dict:
    """A scanned student as a top-students row: no name, no school."""
    test = batch.test
    share = percent_of(sheet, test)
    gender = (sheet.fields.get("gender") or "").strip().lower()
    return {"gender": {"female": "F", "male": "M"}.get(gender, ""), "block": block_name, "percent": round(share, 4),
            "skills": {r["skill"]: round(r["correct"] / r["total"], 4)
                       for r in skill_scores(sheet.answers, test.answer_key, test.skill_map) if r["total"]},
            "band": band_of(share), "top5": bool(sheet.top5 or sheet.top1), "top1": bool(sheet.top1)}


def top_entries(entry: dict) -> List[dict]:
    """The top students of a district: the rows taken from the team's sheet, then the scanned
    students an admin marked."""
    out = [{"gender": r.gender or "", "block": block_name(r.block or ""), "percent": r.percent, "skills": r.skills,
            "band": r.band or "", "top5": bool(r.top5 or r.top1), "top1": bool(r.top1)}
           for r in entry["district"].top_rows]
    for row in entry["blocks"]:
        for batch in row["batches"]:
            if batch.dashboard_left_out:
                continue
            out += [top_sheet(s, batch, block_name(row["block"].name)) for s in counted(batch) if s.top5 or s.top1]
    return out


def _cell(value):
    return "" if value is None else value


def build_feed(session, at: datetime, picture: Optional[dict] = None) -> dict:
    """The numbers as the dashboard reads them, as they stand now."""
    entries = (picture or work_out(session))["districts"]
    state_rows = []
    block_tabs = []
    top_tabs = []
    for i, entry in enumerate(entries, 1):
        d = entry["district"]
        blocks_count = d.blocks_count if d.blocks_count is not None else (len(entry["blocks"]) or None)
        state_rows.append([i, d.state or "", d.name, _cell(blocks_count), _cell(d.total_schools), d.grade or "",
                           _cell(d.total_students), d.target_date.isoformat() if d.target_date else ""])
        if entry["blocks"]:
            rows = []
            for j, row in enumerate(entry["blocks"], 1):
                b = row["block"]
                shown = {**row["shown"], "status": row["status"]}
                rows.append([j, d.state or "", d.name, block_name(b.name)] + [_cell(getattr(b, name)) for _, name in PROGRAMME_COLUMNS]
                            + [_cell(shown.get(name)) for _, name in BLOCK_COLUMNS])
            block_tabs.append({"tab": d.name, "header": BLOCK_HEADER, "rows": rows})
        students = top_entries(entry)
        if students:
            skills: List[str] = []
            for s in students:
                skills += [name for name in s["skills"] if name not in skills]
            top_tabs.append({
                "tab": f"Top students_{d.name}",
                "header": ["Gender", "Block Name", "Total Percent"] + skills + ["Performance band", "Top 5 %", "Top 1 %"],
                "rows": [[s["gender"], s["block"], _cell(s["percent"])] + [_cell(s["skills"].get(name)) for name in skills]
                         + [s["band"], "Yes" if s["top5"] else "", "Yes" if s["top1"] else ""] for s in students]})
    most = hands_on_max(session)
    state = next((e["district"].state for e in entries if e["district"].state), "State")
    return {"fetchedAt": at.isoformat(),
            "tabs": {"Districts": {"tab": state, "header": STATE_HEADER, "rows": state_rows},
                     "Config": {"header": ["data_as_of", at.astimezone(INDIA).date().isoformat()],
                                "rows": [["hands_on_max", most]] if most is not None else []}},
            "blockTabs": block_tabs, "topTabs": top_tabs}


def numbers_of(feed: dict) -> dict:
    """A feed without the time it was made, to tell whether two feeds say the same thing."""
    tabs = feed.get("tabs") or {}
    return {"state": tabs.get("Districts"), "config": (tabs.get("Config") or {}).get("rows"),
            "blocks": feed.get("blockTabs"), "top": feed.get("topTabs")}


def district_totals(feed: dict) -> Dict[str, dict]:
    """What a feed says for each district, all its blocks added up: schools reached, students
    reached and students assessed. A figure no block has stays None."""
    out: Dict[str, dict] = {}
    for tab in feed.get("blockTabs") or []:
        at = {str(h): i for i, h in enumerate(tab.get("header") or [])}
        sums: Dict[str, Optional[float]] = {name: None for name, _ in HISTORY_COLUMNS}
        for row in tab.get("rows") or []:
            for name, header in HISTORY_COLUMNS:
                i = at.get(header)
                value = row[i] if i is not None and i < len(row) else None
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    sums[name] = (sums[name] or 0) + value
        out[str(tab.get("tab") or "")] = {k: None if v is None else int(round(v)) for k, v in sums.items()}
    return out


def week_end(day):
    return day + timedelta(days=(WEEK_ENDS_ON - day.weekday()) % 7)


def history_tab(days) -> dict:
    """The History tab the dashboard reads, from the days kept at each publish (IgniteDay rows):
    for each week and district, the last day of that week with a publish. A district with no numbers
    yet is left out: the dashboard would read its empty cells as 0."""
    last: Dict[tuple, object] = {}
    for d in sorted(days, key=lambda d: d.day):
        if d.schools_reached is not None or d.students_reached is not None or d.assessed is not None:
            last[(week_end(d.day), key(d.district))] = d
    rows = [[d.day.isoformat(), d.district, _cell(d.schools_reached), _cell(d.students_reached), _cell(d.assessed)]
            for _, d in sorted(last.items(), key=lambda kv: (kv[0][0], kv[1].district.lower()))]
    return {"tab": "History", "header": HISTORY_HEADER, "rows": rows}


def published_figures(feed: dict) -> Dict[tuple, dict]:
    """What a published feed says for each block, by (district, block)."""
    out: Dict[tuple, dict] = {}
    for tab in feed.get("blockTabs") or []:
        at = {str(h): i for i, h in enumerate(tab.get("header") or [])}
        for row in tab.get("rows") or []:
            def get(header):
                i = at.get(header)
                return None if i is None or i >= len(row) or row[i] == "" else row[i]
            out[(key(tab.get("tab")), place_key(get("Block")))] = {name: get(header) for header, name in BLOCK_COLUMNS}
    return out
