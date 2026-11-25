"""Database tables. Images are not stored here, only their paths in storage.

Names (of users, answer keys, batches and scanned files) are Unicode, which is NVARCHAR on SQL
Server. Its VARCHAR saves Marathi or Hindi as "?" under the default collation, and under a UTF-8
one counts bytes, three for each such letter, so long names do not fit. Tables made before that
change need the ALTER TABLE lines in docs/AZURE_SETUP.md."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, Unicode, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, scoped_session, sessionmaker


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime]) -> Optional[str]:
    """A time as ISO text with its UTC offset. SQLite hands times back without the offset;
    they were stored as UTC, so say so, or browsers read them as local time."""
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


# What a sign-in service sends as the name when it knows none (Entra External ID's email sign-up does).
PLACEHOLDER_NAMES = {"unknown"}


def real_name(value: Optional[str]) -> str:
    """The person's name, or "" when the sign-in gave none or only a placeholder like "unknown"."""
    name = (value or "").strip()
    return "" if name.lower() in PLACEHOLDER_NAMES else name


def new_id() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(Unicode(200), default="")
    role: Mapped[str] = mapped_column(String(20), default="teacher")        # teacher | admin
    status: Mapped[str] = mapped_column(String(20), default="pending")      # pending | approved | disabled
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    approved_by: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)

    def to_dict(self) -> dict:
        return {"id": self.id, "email": self.email, "name": real_name(self.name), "role": self.role,
                "status": self.status, "created_at": iso(self.created_at),
                "approved_by": self.approved_by}


class Test(Base):
    __tablename__ = "tests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(Unicode(200))
    question_count: Mapped[int] = mapped_column(Integer, default=50)
    options: Mapped[str] = mapped_column(String(26), default="ABCDE")
    marks_correct: Mapped[float] = mapped_column(Float, default=1.0)
    marks_incorrect: Mapped[float] = mapped_column(Float, default=0.0)
    marks_unmarked: Mapped[float] = mapped_column(Float, default=0.0)
    answer_key_json: Mapped[str] = mapped_column(Text, default="{}")
    created_by: Mapped[str] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # IGNITE (both NULL until an admin sets them): which skill each question tests, as
    # {"q1": "Scientific Reasoning", ...}, and the most a student can score in the hands-on
    # activity. No hands_on_max means no hands-on score is asked for with this answer key.
    skill_map_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    hands_on_max: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # The least hands-on score that lets a student go on to the test (3 of 5, from the call on 25
    # November). NULL means none is set. A paper below it is flagged, never refused.
    hands_on_pass: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    batches: Mapped[list["Batch"]] = relationship(back_populates="test")

    @property
    def answer_key(self) -> Dict[str, str]:
        return json.loads(self.answer_key_json or "{}")

    @answer_key.setter
    def answer_key(self, value: Dict[str, str]) -> None:
        self.answer_key_json = json.dumps(value)

    @property
    def skill_map(self) -> Dict[str, str]:
        return json.loads(self.skill_map_json or "{}")

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "question_count": self.question_count, "options": self.options,
                "marks_correct": self.marks_correct, "marks_incorrect": self.marks_incorrect,
                "marks_unmarked": self.marks_unmarked, "answer_key": self.answer_key,
                "created_by": self.created_by, "created_at": iso(self.created_at),
                "archived": self.archived, "skill_map": self.skill_map, "hands_on_max": self.hands_on_max,
                "hands_on_pass": self.hands_on_pass}


class State(Base):
    """A state (Maharashtra, say) that batches of sheets are filed under. Teachers make them as
    they need them, on the "Check sheets" screen."""
    __tablename__ = "states"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(Unicode(200), unique=True)
    created_by: Mapped[str] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    batches: Mapped[list["Batch"]] = relationship(back_populates="state")

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "created_by": self.created_by, "created_at": iso(self.created_at)}


class Batch(Base):
    """A set of sheets checked with one answer key, filed under a state. Sheets can be added to it
    at any time: status is "open" while a run of checking is adding sheets (or was cut off) and
    "finished" when the last run ended, at finished_at."""
    __tablename__ = "batches"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    test_id: Mapped[str] = mapped_column(ForeignKey("tests.id"), index=True)
    # Nullable: batches made before states existed have none (see add_missing_columns).
    state_id: Mapped[Optional[str]] = mapped_column(ForeignKey("states.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(Unicode(200), default="")
    created_by: Mapped[str] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="open")         # open | finished
    # IGNITE (all NULL on batches made without it): where and when the test was taken, typed by
    # the teacher, and who sent the checked batch on to the admin, and when. students_reached is
    # the admin's own figure; without one it is the number of sheets.
    district: Mapped[Optional[str]] = mapped_column(Unicode(200), nullable=True)
    block: Mapped[Optional[str]] = mapped_column(Unicode(200), nullable=True)
    school: Mapped[Optional[str]] = mapped_column(Unicode(200), nullable=True)
    # The schools at this session, as a JSON list: most tests are at a central place, with
    # students from many schools (the team's answer 3). school then holds them joined, for
    # reading; a batch from before the list has only school.
    schools_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    grade: Mapped[Optional[str]] = mapped_column(Unicode(50), nullable=True)
    assessed_on: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    students_reached: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_by: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    # An admin keeps a submitted batch out of the dashboard's numbers.
    dashboard_left_out: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    test: Mapped[Test] = relationship(back_populates="batches")
    state: Mapped[Optional[State]] = relationship(back_populates="batches")
    sheets: Mapped[list["Sheet"]] = relationship(back_populates="batch", cascade="all, delete-orphan")

    @property
    def schools(self) -> List[str]:
        """The schools at this session; one for a batch from before the list, none when not typed."""
        if self.schools_json:
            return json.loads(self.schools_json)
        return [self.school] if self.school else []

    def to_dict(self, with_counts: bool = True) -> dict:
        d = {"id": self.id, "test_id": self.test_id, "test_name": self.test.name if self.test else None,
             "state_id": self.state_id, "state_name": self.state.name if self.state else None,
             "name": self.name, "created_by": self.created_by,
             "created_at": iso(self.created_at),
             "finished_at": iso(self.finished_at), "status": self.status,
             "district": self.district or "", "block": self.block or "", "school": ", ".join(self.schools),
             "schools": self.schools,
             "grade": self.grade or "", "assessed_on": self.assessed_on.isoformat() if self.assessed_on else None,
             "students_reached": self.students_reached,
             "submitted_at": iso(self.submitted_at), "submitted_by": self.submitted_by or "",
             "dashboard_left_out": bool(self.dashboard_left_out)}
        if with_counts:
            # A sheet left out (a page scanned twice, a blank page) is in no count.
            sheets = [s for s in self.sheets if not s.left_out]
            d["sheet_count"] = len(sheets)
            d["left_out_count"] = len(self.sheets) - len(sheets)
            d["read_count"] = sum(1 for s in sheets if s.status == "ok")
            d["review_count"] = sum(1 for s in sheets if s.status == "ok" and s.needs_review)
            d["error_count"] = sum(1 for s in sheets if s.status == "error")
            d["hands_on_count"] = sum(1 for s in sheets if s.hands_on_score is not None)
            scores = [s.score for s in sheets if s.status == "ok" and s.score is not None]
            d["average_score"] = round(sum(scores) / len(scores), 1) if scores else None
            d["max_score"] = len(self.test.answer_key) * self.test.marks_correct if self.test else None
            d["hands_on_max"] = self.test.hands_on_max if self.test else None
        return d


class Sheet(Base):
    __tablename__ = "sheets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    batch_id: Mapped[str] = mapped_column(ForeignKey("batches.id"), index=True)
    source_name: Mapped[str] = mapped_column(Unicode(300), default="")
    page_no: Mapped[int] = mapped_column(Integer, default=1)
    input_path: Mapped[str] = mapped_column(String(300), default="")
    checked_path: Mapped[str] = mapped_column(String(300), default="")
    status: Mapped[str] = mapped_column(String(20), default="ok")           # ok | error
    error_reason: Mapped[str] = mapped_column(Text, default="")
    fields_json: Mapped[str] = mapped_column(Text, default="{}")
    answers_json: Mapped[str] = mapped_column(Text, default="{}")
    score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False)
    review_reason: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    # Who checked this sheet (email). NULL on sheets checked before the column existed.
    created_by: Mapped[Optional[str]] = mapped_column(String(320), nullable=True, default="")
    # IGNITE (all NULL on a sheet nobody has corrected). original_json is the first reading, kept
    # from the first correction on; changes_json lists who changed what, and when. confirmed_* is
    # the person who looked at a sheet that needed a check and said it is right now.
    hands_on_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    original_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    changes_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    confirmed_by: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    entered_by_hand: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    left_out: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    # An admin marks the top students of a district for the dashboard.
    top5: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    top1: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    batch: Mapped[Batch] = relationship(back_populates="sheets")

    @property
    def fields(self) -> Dict[str, str]:
        return json.loads(self.fields_json or "{}")

    @property
    def answers(self) -> Dict[str, str]:
        return json.loads(self.answers_json or "{}")

    @property
    def original(self) -> Optional[dict]:
        return json.loads(self.original_json) if self.original_json else None

    @property
    def changes(self) -> List[dict]:
        return json.loads(self.changes_json or "[]")

    def to_dict(self) -> dict:
        d = {"id": self.id, "batch_id": self.batch_id, "source_name": self.source_name, "page_no": self.page_no,
             "status": self.status, "error_reason": self.error_reason, "fields": self.fields,
             "answers": self.answers, "score": self.score, "needs_review": self.needs_review,
             "review_reason": self.review_reason, "has_checked_image": bool(self.checked_path),
             "created_at": iso(self.created_at), "created_by": self.created_by or "",
             "hands_on_score": self.hands_on_score, "left_out": bool(self.left_out),
             "entered_by_hand": bool(self.entered_by_hand),
             "confirmed_by": self.confirmed_by or "", "confirmed_at": iso(self.confirmed_at),
             "top5": bool(self.top5), "top1": bool(self.top1)}
        if self.original_json:
            d["original"] = self.original
        if self.changes_json:
            d["changes"] = self.changes
        return d


# ---- IGNITE: what the dashboard shows that no scan can say ------------------------------------
# The programme (districts and their blocks, with the figures the team types), the numbers the
# dashboard had before the app fed it ("opening" numbers, taken once from the team's sheet), and
# every set of numbers an admin has published. None of these tables holds a student's name.

class IgniteDistrict(Base):
    """One row of the state table of the dashboard."""
    __tablename__ = "ignite_districts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    state: Mapped[str] = mapped_column(Unicode(200), default="")
    name: Mapped[str] = mapped_column(Unicode(200))
    position: Mapped[int] = mapped_column(Integer, default=0)
    blocks_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    total_schools: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    grade: Mapped[Optional[str]] = mapped_column(Unicode(50), nullable=True)
    total_students: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    target_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    blocks: Mapped[list["IgniteBlock"]] = relationship(back_populates="district", cascade="all, delete-orphan",
                                                         order_by="IgniteBlock.position")
    top_rows: Mapped[list["IgniteTopRow"]] = relationship(back_populates="district", cascade="all, delete-orphan",
                                                           order_by="IgniteTopRow.position")


class IgniteBlock(Base):
    """One block of a district. opening_json holds the numbers from before the app fed the
    dashboard; overrides_json a figure an admin typed over the worked-out one, with a note."""
    __tablename__ = "ignite_blocks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    district_id: Mapped[str] = mapped_column(ForeignKey("ignite_districts.id"), index=True)
    name: Mapped[str] = mapped_column(Unicode(200))
    position: Mapped[int] = mapped_column(Integer, default=0)
    total_schools: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    selected_schools: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    student_target: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    status: Mapped[Optional[str]] = mapped_column(Unicode(50), nullable=True)
    opening_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    overrides_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    district: Mapped[IgniteDistrict] = relationship(back_populates="blocks")
    # The schools the team had already counted in the opening number (answer 2): a batch at one
    # of them adds no school, so a school visited again is not counted twice.
    schools: Mapped[list["IgniteSchool"]] = relationship(back_populates="block", cascade="all, delete-orphan",
                                                         order_by="IgniteSchool.position")

    @property
    def opening(self) -> dict:
        return json.loads(self.opening_json or "{}")

    @property
    def overrides(self) -> dict:
        return json.loads(self.overrides_json or "{}")


class IgniteSchool(Base):
    """A school of a block that the team's sheet had already counted, typed in by an admin."""
    __tablename__ = "ignite_schools"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    block_id: Mapped[str] = mapped_column(ForeignKey("ignite_blocks.id"), index=True)
    name: Mapped[str] = mapped_column(Unicode(200))
    position: Mapped[int] = mapped_column(Integer, default=0)
    block: Mapped[IgniteBlock] = relationship(back_populates="schools")


class IgniteDay(Base):
    """A district's totals as published on a day (in India), for the weekly graph. The last
    publish of a day is kept; a restore counts as a publish."""
    __tablename__ = "ignite_days"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    day: Mapped[date] = mapped_column(Date, index=True)
    district: Mapped[str] = mapped_column(Unicode(200))
    schools_reached: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    students_reached: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    assessed: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class IgniteTopRow(Base):
    """A top student from the team's sheet, as the dashboard shows one: no name, no school."""
    __tablename__ = "ignite_top_rows"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    district_id: Mapped[str] = mapped_column(ForeignKey("ignite_districts.id"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    gender: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    block: Mapped[Optional[str]] = mapped_column(Unicode(200), nullable=True)
    percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    skills_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    band: Mapped[Optional[str]] = mapped_column(Unicode(50), nullable=True)
    top5: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    top1: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    district: Mapped[IgniteDistrict] = relationship(back_populates="top_rows")

    @property
    def skills(self) -> dict:
        return json.loads(self.skills_json or "{}")


class IgniteSetting(Base):
    """A setting of the programme, such as hands_on_max."""
    __tablename__ = "ignite_settings"
    key: Mapped[str] = mapped_column(String(50), primary_key=True)
    value: Mapped[str] = mapped_column(Unicode(200), default="")


class IgniteSnapshot(Base):
    """The numbers as an admin published them. The dashboard reads the newest one."""
    __tablename__ = "ignite_snapshots"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    published_by: Mapped[str] = mapped_column(String(320))
    note: Mapped[str] = mapped_column(Unicode(500), default="")
    feed_json: Mapped[str] = mapped_column(Text)
    restored_from: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    def to_dict(self) -> dict:
        return {"id": self.id, "published_at": iso(self.published_at), "published_by": self.published_by,
                "note": self.note, "restored_from": self.restored_from or ""}


def make_session_factory(database_url: str):
    """Engine plus a scoped session. Azure SQL via pyodbc gets the retry settings serverless needs."""
    kwargs = {"pool_pre_ping": True, "future": True}
    if database_url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    elif database_url.startswith("mssql"):
        kwargs["pool_recycle"] = 300
        kwargs["connect_args"] = {"timeout": 60}   # a paused serverless database takes ~1 minute to wake
    engine = create_engine(database_url, **kwargs)
    if database_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _):
            dbapi_conn.execute("PRAGMA foreign_keys=ON")
    create_tables(engine)
    add_missing_columns(engine)
    return engine, scoped_session(sessionmaker(bind=engine, expire_on_commit=False))


def create_tables(engine, attempts: int = 5) -> None:
    """Create missing tables. Several Gunicorn workers start at once on a fresh database, so two of
    them can race between 'does the table exist?' and 'create it'; the loser just retries."""
    import time
    from sqlalchemy.exc import OperationalError, ProgrammingError

    # SQLite and PostgreSQL say "table X already exists"; SQL Server says
    # "There is already an object named 'X' in the database".
    already_there = ("already exists", "already an object named")

    for attempt in range(attempts):
        try:
            Base.metadata.create_all(engine)
            return
        except (OperationalError, ProgrammingError) as exc:
            message = str(exc).lower()
            if not any(phrase in message for phrase in already_there) or attempt == attempts - 1:
                raise
            time.sleep(0.3 * (attempt + 1))


def add_missing_columns(engine) -> None:
    """Add to each table the columns this version has and the database does not: a database made
    by an earlier version keeps its tables, and create_all never changes a table that exists. Every
    column added this way allows NULL, so the rows already there need nothing. Two workers starting
    at once can both try to add one; the loser's "duplicate column" is fine (the column is there).
    The same statements, for running by hand, are in docs/AZURE_SETUP.md."""
    from sqlalchemy import inspect, text
    from sqlalchemy.exc import OperationalError, ProgrammingError

    inspector = inspect(engine)
    keyword = "ADD" if engine.dialect.name == "mssql" else "ADD COLUMN"
    for table in Base.metadata.sorted_tables:
        if not inspector.has_table(table.name):
            continue
        present = {c["name"].lower() for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name.lower() in present:
                continue
            kind = column.type.compile(engine.dialect)
            try:
                with engine.begin() as conn:
                    conn.execute(text(f"ALTER TABLE {table.name} {keyword} {column.name} {kind} NULL"))
            except (OperationalError, ProgrammingError) as exc:
                if "duplicate" not in str(exc).lower() and "already" not in str(exc).lower():
                    raise
