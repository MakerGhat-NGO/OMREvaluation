"""IGNITE: what the dashboard needs that a plain batch of sheets does not have. A batch says where
and when the test was taken, a reading can be corrected (the first reading is kept), a checked
batch is submitted to the admin, and an answer key says which skill each question tests.

This module holds the parts with no routes in them; the routes are in ignite_api.py. All of it is
switched off unless IGNITE_ENABLED is set (see config.py)."""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional

from flask import abort, current_app

from omr import is_right

INDIA = timezone(timedelta(hours=5, minutes=30))
# The school details of a batch and the most letters each may have. The schools are a list.
DETAILS = {"district": 200, "block": 200, "grade": 50}
MOST_SCHOOLS = 200                  # schools on one batch


def school_key(name) -> str:
    """A school's name for comparing: "Z.P.P.S. Sunderpur" and "zpps sunderpur" are one school.
    Letters (with their vowel signs) of any script are kept, so Marathi names compare too."""
    return "".join(ch for ch in str(name or "").lower() if ch.isalnum() or unicodedata.category(ch).startswith("M"))


def clean_schools(names, limit: int = MOST_SCHOOLS) -> List[str]:
    """Typed school names, tidied, each school once (the first spelling is kept)."""
    if isinstance(names, str):
        names = [names]
    if not isinstance(names, (list, tuple)):
        abort(400, "schools must be a list of school names")
    out, seen = [], set()
    for name in names:
        name = clean_text(name, 200)
        k = school_key(name)
        if k and k not in seen:
            seen.add(k)
            out.append(name)
    if len(out) > limit:
        abort(400, f"a batch can have at most {limit} schools")
    return out


def school_from_file(name) -> str:
    """The school in the name of a scan the team named "Name_Grade_School_Block.pdf"; else ""."""
    parts = [" ".join(p.split()) for p in re.sub(r"\.[A-Za-z0-9]+$", "", str(name or "")).split("_")]
    return parts[2] if len(parts) == 4 and all(parts) else ""


def school_of(sheet, batch) -> str:
    """The school of one paper: the batch's school when it has one. With many, the school in the
    scan's name when it is one of the batch's; else "" (a list of schools is never put on one student)."""
    names = batch.schools
    if len(names) == 1:
        return names[0]
    found = school_key(school_from_file(sheet.source_name))
    return next((name for name in names if found and school_key(name) == found), "")


def set_schools(batch, names: List[str]) -> None:
    batch.schools_json = json.dumps(names) if names else None   # ASCII: the column is not Unicode on SQL Server
    batch.school = ", ".join(names)[:200] or None


def ignite_on() -> bool:
    return bool(getattr(current_app.extensions["settings"], "IGNITE_ENABLED", False))


def clean_text(value, limit: int = 200) -> str:
    """Typed text with its spaces tidied, cut to the length its column holds."""
    return " ".join(str(value or "").split())[:limit]


def parse_day(value) -> Optional[date]:
    """"2026-11-10" as a date; nothing typed as no date."""
    if value in (None, ""):
        return None
    try:
        day = date.fromisoformat(str(value)[:10])
    except ValueError:
        abort(400, "the date of the assessment must look like 2026-11-10")
    if day > datetime.now(INDIA).date():
        abort(400, "the date of the assessment cannot be after today")
    return day


def set_details(batch, body: dict, only_filled: bool = False) -> None:
    """Writes the school details that body has onto the batch. With only_filled, a detail that body
    leaves empty is left as it is: sheets added later to a batch do not wipe what was typed before."""
    for key, limit in DETAILS.items():
        if key in body:
            value = clean_text(body[key], limit)
            if value or not only_filled:
                setattr(batch, key, value or None)
    # "schools" is the list; "school" alone (from an older screen) is a list of one. With
    # only_filled, sheets added later from other schools add those schools to the list.
    if "schools" in body or "school" in body:
        names = clean_schools(body["schools"] if "schools" in body else body["school"])
        if only_filled:
            names = clean_schools(batch.schools + names)
        if names or not only_filled:
            set_schools(batch, names)
    if "assessed_on" in body:
        day = parse_day(body["assessed_on"])
        if day or not only_filled:
            batch.assessed_on = day


def skill_scores(answers: Dict[str, str], answer_key: Dict[str, str], skill_map: Dict[str, str]) -> List[dict]:
    """How many of each skill's questions were answered right, as [{"skill", "correct", "total"}],
    the skills in the order of their first question. A question with no skill, or with no answer
    in the key, is in none of them."""
    out: Dict[str, dict] = {}
    for q in sorted(answer_key, key=lambda q: int(q[1:])):
        skill = skill_map.get(q)
        if not skill:
            continue
        row = out.setdefault(skill, {"skill": skill, "correct": 0, "total": 0})
        row["total"] += 1
        if is_right(answers.get(q) or "", answer_key[q]):
            row["correct"] += 1
    return list(out.values())


def sheet_dict(sheet, answer_key: Dict[str, str], skill_map: Dict[str, str]) -> dict:
    """A sheet for the page, with its skill scores when the answer key has skills."""
    d = sheet.to_dict()
    if skill_map and sheet.status == "ok":
        d["skills"] = skill_scores(sheet.answers, answer_key, skill_map)
    return d
