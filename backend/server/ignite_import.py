"""IGNITE: taking over the team's sheet, once. The Excel download of the sheet the dashboard reads
today gives the programme (districts, blocks, their figures), the numbers so far (kept as the
opening numbers of each block) and the top students so far.

Only the columns the dashboard shows are read. The name and the school of a student stay in the
file: they are never read, so they can never be stored."""
from __future__ import annotations

import json
import math
import re
from datetime import date, datetime
from typing import Dict, List, Optional

from .ignite import clean_text
from .ignite_feed import band_of, block_name, key
from .models import IgniteBlock, IgniteDistrict, IgniteSetting, IgniteTopRow

TOP_TAB = re.compile(r"^top\s*students?\s*[_\-–:·]?\s*(.+)$", re.I)
NO_VALUE = re.compile(r"^(n/?a'?|no|false|0|-|—|not\b.*)?$", re.I)
# Columns of a top-students tab that are never a skill, whatever their values look like.
NOT_SKILL = {"gender", "blockname", "block", "totalpercent", "performanceband", "top5", "top1", "datasource",
             "srno", "sno", "name", "studentname", "school", "schoolname", "district", "state", "score", "total",
             "totalscore", "overallpercent", "percentage", "percent", "remark", "remarks"}
# Opening numbers: the figure and the column of the district tab it is read from.
OPENING = (("schools_reached", "noofschooloutreach"), ("students_reached", "noofstudentsoutreach"),
           ("hands_count", "noofstudentscompletedhandsonactivity"), ("hands_avg", "handsonaveragescore"),
           ("assessed", "numberofstudentscompletedtheassessment"), ("avg", "averageassessmentscore"),
           ("above50", "studentsscoredabove50"), ("above70", "studentsscoredabove70"),
           ("below50", "studentsscoredbelow50"))
WHOLE = {"schools_reached", "students_reached", "hands_count", "assessed", "above50", "above70", "below50"}
# Every paper so far had 25 questions. Some were marked out of 23 by mistake, so the sheet's
# "Total Percent" is wrong for them; a top student's percent is worked out from the score (answer 15).
OLD_TEST_MARKS = 25


def loose(text) -> str:
    """A header for comparing: "Top 5 %" and "top 5%" are the same column."""
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def num(value) -> Optional[float]:
    """A cell as a number; None for an empty cell, "NA", "Not done" and the like. "72%" is 0.72."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    text = str(value).strip().replace(",", "")
    try:
        return float(text[:-1]) / 100 if text.endswith("%") else float(text)
    except ValueError:
        return None


def whole(value) -> Optional[int]:
    x = num(value)
    return None if x is None or x < 0 else int(round(x))


def share(value) -> Optional[float]:
    """0.78, 78 or "78%" as 0.78."""
    x = num(value)
    if x is None:
        return None
    x = x / 100 if x > 1 else x
    return x if 0 <= x <= 1 else None


def day(value) -> Optional[date]:
    """15/10/2026, 2026-10-15 or a date cell as a date."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    try:
        if m := re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", text):
            return date(int(m[3]), int(m[2]), int(m[1]))
        return date.fromisoformat(text[:10]) if text else None
    except ValueError:
        return None


def flag(value) -> bool:
    """"Top 5%", "Yes", TRUE or 1 mark a student; an empty cell, "NA" and "No" do not."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value > 0
    text = str(value or "").strip()
    return not text.startswith("#") and not NO_VALUE.match(text)


class Tab:
    """One tab of the workbook: its name, its header and its rows that are not empty."""

    def __init__(self, title: str, rows: List[tuple]):
        rows = [r for r in rows if any(c not in (None, "") for c in r)]
        self.title = title.strip()
        self.header = list(rows[0]) if rows else []
        self.rows = rows[1:]
        self.names = [loose(h) for h in self.header]

    def col(self, *names: str) -> int:
        return next((i for i, h in enumerate(self.names) if h in names), -1)

    def col_like(self, pattern: str) -> int:
        return next((i for i, h in enumerate(self.header)
                     if re.search(pattern, " ".join(str(h or "").split()).lower())), -1)

    @staticmethod
    def at(row: tuple, i: int):
        return row[i] if 0 <= i < len(row) else None


def read_workbook(stream) -> dict:
    """What the team's sheet says: {"hands_on_max", "districts": [...], "blocks": {district: [...]},
    "top": {district: [...]}}."""
    from openpyxl import load_workbook

    wb = load_workbook(stream, data_only=True, read_only=True)
    tabs = [Tab(ws.title, list(ws.iter_rows(values_only=True))) for ws in wb.worksheets]
    out = {"hands_on_max": None, "districts": [], "blocks": {}, "top": {}}
    for tab in tabs:
        top = TOP_TAB.match(tab.title)
        if loose(tab.title) == "config":
            for row in [tuple(tab.header)] + tab.rows:
                if loose(Tab.at(row, 0)) == "handsonmax":
                    out["hands_on_max"] = num(Tab.at(row, 1))
        elif top:
            out["top"][clean_text(top[1])] = _top_rows(tab)
        elif loose(tab.title).startswith("top"):
            continue                                    # other lists of students: not shown by the dashboard
        elif tab.col("block") >= 0 and (tab.col("totalschools") >= 0 or tab.col("assessmentstatus") >= 0):
            out["blocks"][clean_text(tab.title)] = _block_rows(tab)
        elif tab.col("district") >= 0 and (tab.col("noofblocks") >= 0 or tab.col("nooftotalschools") >= 0):
            out["districts"] += _district_rows(tab)
    return out


def _district_rows(tab: Tab) -> List[dict]:
    c = {name: tab.col(col) for name, col in (("state", "state"), ("name", "district"), ("blocks", "noofblocks"),
                                              ("schools", "nooftotalschools"), ("grade", "grade"),
                                              ("students", "nooftotalstudents"))}
    c_date = tab.col_like(r"^(target|end)\s*date")
    out = []
    for row in tab.rows:
        name = clean_text(Tab.at(row, c["name"]))
        if not name or key(name) in ("total", "grand total"):
            continue
        out.append({"state": clean_text(Tab.at(row, c["state"])), "name": name,
                    "blocks_count": whole(Tab.at(row, c["blocks"])), "total_schools": whole(Tab.at(row, c["schools"])),
                    "grade": clean_text(Tab.at(row, c["grade"]), 50), "total_students": whole(Tab.at(row, c["students"])),
                    "target_date": day(Tab.at(row, c_date))})
    return out


def _block_rows(tab: Tab) -> List[dict]:
    c_name, c_state, c_status = tab.col("block"), tab.col("state"), tab.col("assessmentstatus")
    c_total, c_target = tab.col("totalschools"), tab.col("totalstudentcountstandard")
    c_selected = tab.col("schoolsselectedforprogramimplementation")
    c_girls = tab.col_like(r"^gender\b|\bgirls?\b")
    opening_cols = [(name, tab.col(col)) for name, col in OPENING]
    out = []
    for row in tab.rows:
        name = block_name(clean_text(Tab.at(row, c_name)))
        if not name or key(name) in ("total", "grand total"):
            continue
        opening = {figure: (whole if figure in WHOLE else share if figure == "avg" else num)(Tab.at(row, i))
                   for figure, i in opening_cols}
        opening["girls"] = share(Tab.at(row, c_girls))
        out.append({"state": clean_text(Tab.at(row, c_state)), "name": name,
                    "total_schools": whole(Tab.at(row, c_total)), "selected_schools": whole(Tab.at(row, c_selected)),
                    "student_target": whole(Tab.at(row, c_target)),
                    "status": clean_text(Tab.at(row, c_status), 50), "opening": opening})
    return out


def _top_rows(tab: Tab) -> List[dict]:
    c_gender, c_block = tab.col("gender"), tab.col("blockname", "block")
    c_percent = tab.col("totalpercent", "total", "overallpercent", "percentage")
    c_band, c5, c1 = tab.col("performanceband"), tab.col("top5"), tab.col("top1")
    c_score = tab.col("score", "totalscore")

    def is_share(i: int) -> bool:
        values = [x for x in (Tab.at(r, i) for r in tab.rows) if x not in (None, "") and not NO_VALUE.match(str(x).strip())]
        return bool(values) and all(isinstance(x, (int, float)) and not isinstance(x, bool) and 0 <= x <= 1 for x in values)

    # A skill is any other column that holds shares, as the dashboard decides it.
    skills = [(i, " ".join(str(h).split())) for i, h in enumerate(tab.header)
              if h not in (None, "") and tab.names[i] not in NOT_SKILL and is_share(i)]
    out = []
    for row in tab.rows:
        block, percent = block_name(clean_text(Tab.at(row, c_block))), share(Tab.at(row, c_percent))
        if not block and percent is None:
            continue
        band = clean_text(Tab.at(row, c_band), 50)
        score = num(Tab.at(row, c_score))
        if score is not None and 0 <= score <= OLD_TEST_MARKS:
            from_score = round(score / OLD_TEST_MARKS, 4)
            if percent is None or abs(from_score - percent) > 0.005:
                # Marked out of 23: the percent, and so the band, change (78% is 72%).
                percent, band = from_score, band_of(from_score)
        top1 = flag(Tab.at(row, c1))
        # Without a Top 5 % column, every student in the tab is in the top 5%.
        top5 = top1 or c5 < 0 or flag(Tab.at(row, c5))
        if not top5:
            continue
        gender = str(Tab.at(row, c_gender) or "").strip().lower()
        out.append({"gender": "F" if gender in ("f", "female", "girl", "girls") else
                    "M" if gender in ("m", "male", "boy", "boys") else "",
                    "block": block, "percent": percent,
                    "skills": {name: x for i, name in skills if (x := share(Tab.at(row, i))) is not None},
                    "band": band, "top5": True, "top1": top1})
    return out


def apply_import(session, data: dict, state_default: str = "") -> dict:
    """Writes what read_workbook found. A district or block that is already there (same name) is
    updated: its programme figures and opening numbers come from the file, an admin's own figures
    stay. The top students of a district are replaced by the file's."""
    districts: Dict[str, IgniteDistrict] = {key(d.name): d for d in session.query(IgniteDistrict).all()}
    position = max((d.position for d in districts.values()), default=0)

    def district_named(name: str, state: str) -> IgniteDistrict:
        nonlocal position
        d = districts.get(key(name))
        if d is None:
            position += 1
            d = districts[key(name)] = IgniteDistrict(name=name, state=state or state_default, position=position)
            session.add(d)
        return d

    for row in data["districts"]:
        d = district_named(row["name"], row["state"])
        d.state = row["state"] or d.state
        d.blocks_count, d.total_schools = row["blocks_count"], row["total_schools"]
        d.grade, d.total_students, d.target_date = row["grade"] or None, row["total_students"], row["target_date"]
    blocks = 0
    for name, rows in data["blocks"].items():
        d = district_named(name, next((r["state"] for r in rows if r["state"]), ""))
        session.flush()
        # A block already here under the sheet's other spelling ("Devla") takes the programme's
        # name, so its batches and top students stay with it.
        names = {key(b.name) for b in d.blocks}
        for b in d.blocks:
            if key(block_name(b.name)) not in names:
                names.add(key(block_name(b.name)))
                b.name = block_name(b.name)
        have = {key(b.name): b for b in d.blocks}
        for i, row in enumerate(rows, 1):
            b = have.get(key(row["name"]))
            if b is None:
                b = IgniteBlock(district_id=d.id, name=row["name"])
                d.blocks.append(b)
            b.position = i
            b.total_schools, b.selected_schools = row["total_schools"], row["selected_schools"]
            b.student_target, b.status = row["student_target"], row["status"] or None
            b.opening_json = json.dumps(row["opening"])
            blocks += 1
    top = 0
    for name, rows in data["top"].items():
        d = districts.get(key(name))
        if d is None:
            continue                                    # a top-students tab of a district the file does not have
        session.flush()
        d.top_rows.clear()
        for i, row in enumerate(rows, 1):
            d.top_rows.append(IgniteTopRow(position=i, gender=row["gender"], block=row["block"], percent=row["percent"],
                                           skills_json=json.dumps(row["skills"]), band=row["band"],
                                           top5=row["top5"], top1=row["top1"]))
            top += 1
    # The scale of the activity: taken from the file only when none is set. An admin's own scale
    # stays; the sheet's Config says 25, but the activity is scored out of 5 (answer 9).
    setting = session.get(IgniteSetting, "hands_on_max")
    if data["hands_on_max"] and not (setting and setting.value):
        setting = setting or IgniteSetting(key="hands_on_max")
        setting.value = f"{data['hands_on_max']:g}"
        session.add(setting)
    return {"districts": len(districts), "blocks": blocks, "top_students": top,
            "hands_on_max": data["hands_on_max"]}
