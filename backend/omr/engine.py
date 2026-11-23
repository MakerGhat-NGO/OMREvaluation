"""A thin, stateless wrapper around the OMRChecker core.

The original project reads sheets from a folder and appends to CSV files on disk.
This module turns that into one function call per sheet so the web app can
process uploads directly and keep results in a database.
"""
from __future__ import annotations

import io
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import cv2
import numpy as np

from src.defaults import CONFIG_DEFAULTS
from src.template import Template
from src.utils.image import ImageUtils
from src.utils.parsing import get_concatenated_response

QUESTION_RE = re.compile(r"^q(\d+)$")
# Longest side of a page image handed to the engine. The engine itself works on a
# 666 x 820 copy, so anything above ~1000 px only costs upload time.
PAGE_RENDER_DPI = 100
# The corner-marker warp crops the page exactly at the marker centres, which puts the first
# name column on the image edge. Pad the warped page by this fraction on every side so a
# bubble that prints a little outside the markers is still fully in the picture.
MARGIN_RATIO = 0.03
# Blocks with at least this many columns and rows get their bubble grid re-fitted to the
# printed circles of each scan (see fit_grid_axis). Smaller blocks keep the template layout.
MIN_FITTED_GRID = 5
# How far in from each corner of the page the corner marker reaches, as a fraction of the page's
# width and height. The page is cropped on the centres of its four markers, so a quarter of each
# marker sits at a corner (under the padding): about 4% of the page on a flat scan, 6% on a
# curled phone photo.
CORNER_MARKER_REACH = 0.07
# Checking a row for circles (circle_likeness): where a printed circle's outline is, as a
# range of distances from the centre in circle radii; where the paper beside the circle is,
# along the row toward the next column; how far, in pixels, a circle may sit to either side
# of its fitted column (a curled sheet's columns lean a little by their far end); and how
# far below zero, as a fraction of a placement's typical row, a row must score to count as
# no row of circles.
RING_RADII = (0.72, 1.12)
PAPER_REACH = (1.2, 1.55)
CIRCLE_SLACK = 0
CIRCLE_GATE = 0.5


def circle_response(ink_profile: np.ndarray, pitch: float, circle_radius: float) -> np.ndarray:
    """`ink_profile` scored at every pixel with "ink within a circle's radius minus the ink in
    the gap around it", which peaks at the centre of every circle and gives 0 on flat ink."""
    inner = max(int(round(circle_radius)), 1)
    outer = max(int(round(pitch / 2)), inner + 1)
    kernel = np.full(2 * outer + 1, -1.0, np.float32)
    kernel[outer - inner:outer + inner + 1] = 1.0
    kernel[kernel < 0] *= (2 * inner + 1) / float(np.sum(kernel < 0))   # zero-mean: flat ink scores 0
    return np.convolve(ink_profile.astype(np.float32), kernel, mode="same")


def circle_likeness(area: np.ndarray, column_centres: np.ndarray, circle_radius: float) -> np.ndarray:
    """How much each row of `area` looks like a row of circles under the fitted columns: the
    mean ink on a ring around (column, row), where a printed circle's outline is, minus the
    mean ink on the paper beside it, toward the next column; the best of the positions a
    little to either side of the column, and summed over the columns. One value per row of
    the area. A row of circles, empty or filled, scores well above zero.

    The row profile that `fit_grid_axis` works on sums the ink across the whole row, and the
    row of boxes above a grid, with the student's letters or digits in them and a rule along
    its top and bottom, sums to as much as a row of circles: on a faint scan the roll number
    grid was found a row too high, on the boxes. Seen in two dimensions a box is no circle:
    the ring finds mostly paper, and the rules between the boxes darken the space beside it,
    so the boxes row scores well below zero."""
    ring_in, ring_out = (r * circle_radius for r in RING_RADII)
    paper_in, paper_out = (r * circle_radius for r in PAPER_REACH)
    half = int(np.ceil(paper_out))
    yy, xx = np.mgrid[-half:half + 1, -half:half + 1]
    rr = np.hypot(xx, yy)
    ring = ((rr >= ring_in) & (rr <= ring_out)).astype(np.float32)
    paper = ((np.abs(xx) >= paper_in) & (np.abs(xx) <= paper_out)
             & (np.abs(yy) <= 0.5 * circle_radius)).astype(np.float32)
    response = cv2.filter2D(area, -1, ring / ring.sum()) - cv2.filter2D(area, -1, paper / paper.sum())
    likeness = np.zeros(area.shape[0], np.float32)
    for centre in column_centres:
        j = int(round(centre))
        lo, hi = max(j - CIRCLE_SLACK, 0), min(j + CIRCLE_SLACK + 1, area.shape[1])
        if hi > lo:
            likeness += response[:, lo:hi].max(axis=1)
    return likeness


def settle_centres(ink_profile: np.ndarray, start: float, pitch: float, count: int, circle_radius: float,
                   lined: Optional[np.ndarray] = None, reach: float = 0.3,
                   circles: Optional[np.ndarray] = None) -> np.ndarray:
    """The centres of a fitted grid (`start` plus multiples of `pitch`), each moved to the
    nearest peak of the circle response within `reach` pitches of it.

    A photographed sheet curls, and the lens draws it a little unevenly, so the circles are
    not quite the same distance apart from one end of a grid to the other: a straight grid
    fitted to the whole of it lands half a circle off at one end. A centre with no clear
    circle near it (an empty column at the edge of the picture) stays where the straight grid
    put it, and no centre moves to within most of a pitch of its neighbour."""
    matched = circle_response(ink_profile, pitch, circle_radius)
    xs = np.arange(len(matched))
    centres = start + np.arange(count) * pitch
    typical = float(np.median(np.interp(centres, xs, matched, left=0, right=0)))
    circle_floor = -CIRCLE_GATE * abs(float(np.median(np.interp(centres, xs, circles, left=0, right=0)))) \
        if circles is not None else None
    settled = centres.copy()
    half_steps = int(round(reach * pitch / 0.5))
    for i, centre in enumerate(centres):
        window = centre + 0.5 * np.arange(-half_steps, half_steps + 1)   # the centre itself among them
        values = np.interp(window, xs, matched, left=0, right=0)
        if lined is not None:
            on_line = np.interp(window, xs, lined.astype(np.float32), left=0, right=0)
            values = np.where(on_line > 0.5, 0.0, values)
        if circles is not None:
            values = np.where(np.interp(window, xs, circles, left=0, right=0) < circle_floor, 0.0, values)
        j = int(np.argmax(values))
        if values[j] > max(0.5 * typical, 0.0):
            settled[i] = window[j]
    too_close = 0.6 * pitch
    for i in range(count):
        if (i > 0 and settled[i] - settled[i - 1] < too_close) or (i + 1 < count and settled[i + 1] - settled[i] < too_close):
            settled[i] = centres[i]
    return settled


def fit_grid_axis(ink_profile: np.ndarray, start: float, pitch: float, count: int,
                  circle_radius: float, pitch_tolerance: float = 0.06, search: float = 1.3,
                  lined: Optional[np.ndarray] = None,
                  circles: Optional[np.ndarray] = None) -> Tuple[float, float]:
    """Find where a row of `count` printed circles really is along one axis.

    `ink_profile` is the darkness summed across the other axis (one value per pixel).
    Each printed circle (outline plus the letter or digit inside it) shows up as a band of
    ink `circle_radius` either side of its centre, with a paler gap before the next one.
    The profile is scored with "ink inside the circle minus ink in the gap around it",
    which peaks sharply at every circle centre. Starting from the template's `start`
    centre and `pitch`, offsets up to `search` pitches away and nearby pitches are tried,
    and the placement whose circle centres score highest wins. Different print runs of the
    sheet shift and stretch the grids, by a few pixels or by a whole circle.

    A grid is periodic, so a placement one pitch off puts every circle centre but one on a
    circle too: the spare one lands on blank paper or on whatever is printed next to the
    grid. Each centre therefore counts no more than the typical centre of that placement
    (the median), so a stroke of ink next to the grid cannot make up for the circle that is
    missed, and the placement with every centre on a circle wins by one circle. `lined`
    marks the positions (one flag per pixel) that hold a line drawn right across the grid,
    such as the boxes a student writes the letters in above the name grid: a row of boxes
    with letters in them scores like a row of circles, but no row of circles has a line
    through its whole width, so a centre that falls there counts nothing. `circles`, when
    given, says for each position how much it looks like a row of circles seen in two
    dimensions (circle_likeness: well below zero on the boxes above a grid), and a centre
    that falls where it is far below zero, next to what the placement's typical centre
    scores, counts nothing either. Between placements that score nearly the same, the one
    nearer the template's position is preferred.
    """
    matched = circle_response(ink_profile, pitch, circle_radius)
    xs = np.arange(len(matched))
    idx = np.arange(count)
    half_steps = int(round(search * pitch / 0.5))
    starts = start + 0.5 * np.arange(-half_steps, half_steps + 1)   # the template's own position among them
    distance = np.abs(starts - start) / pitch      # in pitches
    best = (-np.inf, start, pitch)
    for p in np.arange(pitch * (1 - pitch_tolerance), pitch * (1 + pitch_tolerance) + 1e-6, 0.1):
        centres = starts[:, None] + idx[None, :] * p
        values = np.interp(centres.ravel(), xs, matched, left=0, right=0).reshape(centres.shape)
        if lined is not None:
            on_line = np.interp(centres.ravel(), xs, lined.astype(np.float32), left=0, right=0).reshape(centres.shape)
            values = np.where(on_line > 0.5, 0.0, values)
        if circles is not None:
            likeness = np.interp(centres.ravel(), xs, circles, left=0, right=0).reshape(centres.shape)
            floor = -CIRCLE_GATE * np.abs(np.median(likeness, axis=1, keepdims=True))
            values = np.where(likeness < floor, 0.0, values)
        typical = np.median(values, axis=1, keepdims=True)
        scores = np.minimum(values, typical).sum(axis=1) - 0.03 * count * np.abs(typical[:, 0]) * distance
        i = int(np.argmax(scores))
        if scores[i] > best[0]:
            best = (float(scores[i]), float(starts[i]), float(p))
    return best[1], best[2]


def lines_across(ink_area: np.ndarray, axis: int, reach: float, radius: float, min_run: float) -> np.ndarray:
    """Which positions along `axis` of this area lie within `reach` pixels of a line drawn
    across it: a row (axis 0) or column (axis 1) of the area in which ink runs unbroken for
    at least `min_run` pixels, while the rows (columns) most of a circle before and after it
    hold no such run.

    The circle outlines and the letters printed in them are short, one circle at most, so
    only the rule of a row of boxes, or a border beside the grid, runs on for many circles.
    A few filled bubbles side by side run as far as a line, but they are a whole circle
    thick, so the same run is there again most of a circle away; a line is not. (How much
    of a row or column is inked says nothing: a column of ten circles with digits in them
    inks well over half of its height.)"""
    dark = (ink_area > max(80.0, float(np.median(ink_area)) + 30.0)).astype(np.uint8)
    # Closing along the line bridges the one-pixel breaks that scanning leaves in a faint one.
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((1, 3) if axis == 0 else (3, 1), np.uint8))
    strokes = dark > 0 if axis == 0 else dark.T > 0     # one row per position along `axis`
    counts = np.cumsum(strokes, axis=1)
    run = counts - np.maximum.accumulate(np.where(strokes, 0, counts), axis=1)
    long = run.max(axis=1) >= min_run
    if not long.any():
        return long
    away = max(int(round(0.7 * radius)), 2)
    before = np.concatenate([np.zeros(away, bool), long[:-away]])
    after = np.concatenate([long[away:], np.zeros(away, bool)])
    lined = long & ~before & ~after
    if not lined.any():
        return lined
    width = 2 * int(round(reach)) + 1
    spread = np.convolve(lined.astype(np.float32), np.ones(width, np.float32), mode="same")
    return spread > 0


def straight_line_map(pairs: List[Tuple[float, float, float]]):
    """The straight line `fitted = a * template + b` through (template, fitted, weight)
    pairs, by weighted least squares; with every pair at one template position (one grid
    axis only) it is a plain shift."""
    template = np.array([p[0] for p in pairs], np.float64)
    fitted = np.array([p[1] for p in pairs], np.float64)
    weight = np.sqrt(np.array([max(p[2], 1.0) for p in pairs], np.float64))
    if np.ptp(template) < 1.0:
        shift = float(np.average(fitted - template, weights=weight ** 2))
        return lambda v: v + shift
    a, b = np.polyfit(template, fitted, 1, w=weight)
    return lambda v: a * v + b


def mobile_digits_reason(mobile: str) -> Optional[str]:
    """Why a mobile number read from a sheet needs a look: some of its ten columns are filled and
    some are not (a column skipped, or a stray mark). A sheet with no mobile number at all is
    fine, and so is one with a doubled column, which is reported on its own."""
    digits = len(mobile.replace(" ", ""))
    if digits == 0 or digits >= 10:
        return None
    return f"mobile number has {digits} digit{'s' if digits != 1 else ''}, not 10"


@dataclass
class SheetResult:
    ok: bool
    fields: Dict[str, str] = field(default_factory=dict)      # Name, Roll Number, ...
    answers: Dict[str, str] = field(default_factory=dict)     # q1 -> "A", "" when blank, "CD" when double
    score: Optional[float] = None
    needs_review: bool = False
    review_reason: str = ""
    error_reason: str = ""
    checked_image_jpeg: Optional[bytes] = None
    # Where each question and field sits on the checked picture, as fractions of its width and
    # height: label -> [left, top, right, bottom]. Lets the web page box the ones to look at.
    layout: Dict[str, List[float]] = field(default_factory=dict)


def load_pages(data: bytes, filename: str) -> List[np.ndarray]:
    """Turn an uploaded file into grayscale page images. PDFs yield one image per page."""
    name = (filename or "").lower()
    if name.endswith(".pdf") or data[:5] == b"%PDF-":
        import pymupdf  # imported lazily: only needed when a PDF arrives

        pages = []
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            for page in doc:
                pix = page.get_pixmap(dpi=PAGE_RENDER_DPI, colorspace=pymupdf.csGRAY)
                img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
                pages.append(img.copy())
        return pages
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("file is not a PDF, JPEG or PNG")
    return [img]


# A key's answer for one question is written in one of three ways:
#   "B"    one right answer
#   "BC"   B and C must both be filled (and nothing else)
#   "B/C"  B or C: either one alone is right
ANY_ONE = "/"


def key_letters(correct: str) -> str:
    """The letters of a key's answer, without the mark that says "any one of them"."""
    return (correct or "").replace(ANY_ONE, "")


def needs_all(correct: str) -> bool:
    """True when the key asks for several bubbles to be filled for this question."""
    return ANY_ONE not in (correct or "") and len(key_letters(correct)) > 1


def is_right(marked: str, correct: str) -> bool:
    """Whether what a student filled for one question earns its marks."""
    marked = (marked or "").strip()
    letters = key_letters(correct)
    if not marked or not letters:
        return False
    if ANY_ONE in correct:
        return len(marked) == 1 and marked in letters
    return sorted(marked) == sorted(letters)


def score_answers(answers: Dict[str, str], answer_key: Dict[str, str],
                  marks_correct: float = 1, marks_incorrect: float = 0,
                  marks_unmarked: float = 0) -> float:
    """Marks for each question in the key. Two bubbles filled count as incorrect, unless the key
    asks for exactly those two (see is_right)."""
    total = 0.0
    for q, correct in answer_key.items():
        marked = (answers.get(q) or "").strip()
        if marked == "":
            total += marks_unmarked
        elif is_right(marked, correct):
            total += marks_correct
        else:
            total += marks_incorrect
    return total


class Engine:
    """Holds the loaded sheet template. One instance per process; calls are serialised
    because the underlying OMRChecker code keeps per-call state on the template object."""

    def __init__(self, template_path: Path):
        self.template_path = Path(template_path)
        self.template = Template(self.template_path, CONFIG_DEFAULTS)
        self._lock = threading.Lock()
        self.question_labels = sorted(
            (lbl for lbl in self.template.output_columns if QUESTION_RE.match(lbl)),
            key=lambda s: int(QUESTION_RE.match(s).group(1)),
        )
        self.field_labels = [lbl for lbl in self.template.output_columns if not QUESTION_RE.match(lbl)]
        # What each field (q3, name7, roll2, gender ...) reads as when exactly one of its bubbles is
        # filled. Two filled bubbles read as their values run together ("AB", "MaleFemale").
        self._single_values: Dict[str, set] = {}
        for block in self.template.field_blocks:
            for field in block.traverse_bubbles:
                for pt in field:
                    self._single_values.setdefault(pt.field_label, set()).add(str(pt.field_value))
        # The field a column belongs to: name7 -> Name, roll2 -> Roll Number.
        self._field_of_part = {part: label for label, parts in self.template.custom_labels.items() for part in parts}
        # The template's bubble positions, kept so every read starts from the same layout.
        self._template_points = [
            (pt, pt.x, pt.y)
            for block in self.template.field_blocks
            for field in block.traverse_bubbles
            for pt in field
        ]

    def _place_bubbles(self, img: np.ndarray, margin_x: float, margin_y: float, scale_x: float, scale_y: float):
        """Move every bubble window to where it is on this particular page image.

        First the template layout is shifted for the padding added around the warped page,
        then each large grid (name, roll, mobile, answers) is fitted to the circles actually
        printed on the sheet, and each small block (gender) is moved along with the fitted
        grid nearest to it.
        """
        for pt, x, y in self._template_points:
            pt.x = round((x + margin_x) * scale_x)
            pt.y = round((y + margin_y) * scale_y)
        page_h, page_w = img.shape[:2]
        ink = 255 - img.astype(np.float32)
        # The corner markers belong to no grid, and the ink of one would draw the nearest centres
        # (the last answer row, the last option column) toward it.
        reach_x, reach_y = int(round(CORNER_MARKER_REACH * page_w)), int(round(CORNER_MARKER_REACH * page_h))
        for ys in (slice(0, reach_y), slice(page_h - reach_y, page_h)):
            for xs in (slice(0, reach_x), slice(page_w - reach_x, page_w)):
                ink[ys, xs] = 0.0
        # Where the first and last circle centres of each fitted grid were in the template
        # and where they are on this page, per axis, weighted by the grid's span.
        fitted_x: List[Tuple[float, float, float]] = []
        fitted_y: List[Tuple[float, float, float]] = []
        small = []
        for block in self.template.field_blocks:
            box_w, box_h = block.bubble_dimensions
            points = [pt for field in block.traverse_bubbles for pt in field]
            cols = sorted({pt.x for pt in points})
            rows = sorted({pt.y for pt in points})
            if len(cols) < MIN_FITTED_GRID or len(rows) < MIN_FITTED_GRID:
                small.append(block)
                continue
            pitch_x = (cols[-1] - cols[0]) / (len(cols) - 1)
            pitch_y = (rows[-1] - rows[0]) / (len(rows) - 1)
            # Ink inside the block's area only: the grid may sit up to a circle further out
            # than the template says, so the area reaches one and a half pitches beyond it.
            x0 = max(int(cols[0] - 1.5 * pitch_x), 0)
            x1 = min(int(cols[-1] + box_w + 1.5 * pitch_x), page_w)
            y0 = max(int(rows[0] - 1.5 * pitch_y), 0)
            y1 = min(int(rows[-1] + box_h + 1.5 * pitch_y), page_h)
            area = ink[y0:y1, x0:x1]
            # The printed circles are about as big as the smaller side of the bubble window.
            radius = 0.5 * min(box_w, box_h)
            col_profile = np.zeros(page_w, np.float32)
            col_profile[x0:x1] = area.sum(axis=0)
            row_profile = np.zeros(page_h, np.float32)
            row_profile[y0:y1] = area.sum(axis=1)
            # Lines drawn across the area (the boxes above a grid, a border beside one) are no
            # place for a circle centre, however much ink they carry.
            col_lined = np.zeros(page_w, bool)
            col_lined[x0:x1] = lines_across(area, 1, 0.45 * pitch_x, radius, 3.5 * pitch_y)
            row_lined = np.zeros(page_h, bool)
            row_lined[y0:y1] = lines_across(area, 0, 0.45 * pitch_y, radius, 3.5 * pitch_x)
            start_x, fit_pitch_x = fit_grid_axis(col_profile, cols[0] + box_w / 2, pitch_x, len(cols), radius,
                                                 lined=col_lined)
            col_centres = settle_centres(col_profile, start_x, fit_pitch_x, len(cols), radius, col_lined)
            # With the columns known, each row can be checked for circles under them.
            row_circles = np.zeros(page_h, np.float32)
            row_circles[y0:y1] = circle_likeness(area, col_centres - x0, radius)
            start_y, fit_pitch_y = fit_grid_axis(row_profile, rows[0] + box_h / 2, pitch_y, len(rows), radius,
                                                 lined=row_lined, circles=row_circles)
            row_centres = settle_centres(row_profile, start_y, fit_pitch_y, len(rows), radius, row_lined,
                                         circles=row_circles)
            col_index = {x: i for i, x in enumerate(cols)}
            row_index = {y: i for i, y in enumerate(rows)}
            for pt in points:
                cx = col_centres[col_index[pt.x]]
                cy = row_centres[row_index[pt.y]]
                pt.x = int(min(max(round(cx - box_w / 2), 0), page_w - box_w))
                pt.y = int(min(max(round(cy - box_h / 2), 0), page_h - box_h))
            span_x = (len(cols) - 1) * pitch_x
            span_y = (len(rows) - 1) * pitch_y
            fitted_x += [(cols[0] + box_w / 2, start_x, span_x),
                         (cols[-1] + box_w / 2, start_x + (len(cols) - 1) * fit_pitch_x, span_x)]
            fitted_y += [(rows[0] + box_h / 2, start_y, span_y),
                         (rows[-1] + box_h / 2, start_y + (len(rows) - 1) * fit_pitch_y, span_y)]
        # A block too small to fit on its own (the two gender bubbles, the answer columns) is
        # moved and stretched the way the fitted grids were: the whole sheet is printed in
        # one go, so one straight-line map per axis, fitted through the grids, carries the
        # print run's offset and scale to every other bubble on the page.
        if not small or not fitted_x:
            return
        map_x = straight_line_map(fitted_x)
        map_y = straight_line_map(fitted_y)
        for block in small:
            box_w, box_h = block.bubble_dimensions
            for field in block.traverse_bubbles:
                for pt in field:
                    cx = map_x(pt.x + box_w / 2)
                    cy = map_y(pt.y + box_h / 2)
                    pt.x = int(min(max(round(cx - box_w / 2), 0), page_w - box_w))
                    pt.y = int(min(max(round(cy - box_h / 2), 0), page_h - box_h))

    def _layout(self) -> Dict[str, List[float]]:
        """Box around every question and field as the bubbles are placed right now (call it after
        _place_bubbles, inside the lock, so it describes this scan). Fractions of the page size,
        which is also the size of the checked picture."""
        page_w, page_h = self.template.page_dimensions
        spans: Dict[str, List[float]] = {}

        def grow(label: str, box: List[float]) -> None:
            cur = spans.get(label)
            spans[label] = list(box) if cur is None else [
                min(cur[0], box[0]), min(cur[1], box[1]), max(cur[2], box[2]), max(cur[3], box[3])]

        for block in self.template.field_blocks:
            box_w, box_h = block.bubble_dimensions
            for field_bubbles in block.traverse_bubbles:
                for pt in field_bubbles:
                    x0 = pt.x + block.shift
                    grow(pt.field_label, [x0, pt.y, x0 + box_w, pt.y + box_h])
        # A custom label such as Name covers all of its columns (name1 .. name30).
        for label, parts in self.template.custom_labels.items():
            for part in parts:
                if part in spans:
                    grow(label, spans[part])
        wanted = set(self.question_labels) | set(self.field_labels)
        return {label: [round(b[0] / page_w, 4), round(b[1] / page_h, 4), round(b[2] / page_w, 4), round(b[3] / page_h, 4)]
                for label, b in spans.items() if label in wanted}

    def read(self, page: np.ndarray, name: str = "sheet", questions: Optional[Iterable[str]] = None,
             several_ok: Iterable[str] = ()) -> SheetResult:
        """Reads one page. `questions` are the labels of the questions this test has (q1..q25,
        say): a stray mark in a question beyond them is not worth a teacher's look, so it is
        read and recorded but does not flag the sheet. All of the sheet's questions by default.
        `several_ok` are the questions whose key asks for more than one bubble: two marks there
        are an answer, not something to look at. Never raises for a bad sheet; returns ok=False
        instead."""
        with self._lock:
            return self._read(page, name, questions, set(several_ok))

    def _read(self, page: np.ndarray, name: str, questions: Optional[Iterable[str]] = None,
              several_ok: frozenset = frozenset()) -> SheetResult:
        ops = self.template.image_instance_ops
        ops.reset_all_save_img()
        try:
            warped = ops.apply_preprocessors(name, page.copy(), self.template)
        except Exception as exc:  # the core raises on very odd inputs
            return SheetResult(ok=False, error_reason=f"could not process image: {exc}")
        if warped is None:
            return SheetResult(ok=False, error_reason="corner targets not found: check that all four corners are in the scan")
        # Pad the marker-cropped page, bring it to the template's size and put the bubble
        # windows where this scan's grids really are (see _place_bubbles).
        h, w = warped.shape[:2]
        pad_x, pad_y = int(round(w * MARGIN_RATIO)), int(round(h * MARGIN_RATIO))
        warped = cv2.copyMakeBorder(warped, pad_y, pad_y, pad_x, pad_x, cv2.BORDER_REPLICATE)
        page_w, page_h = self.template.page_dimensions
        img = ImageUtils.resize_util(warped, page_w, page_h)
        self._place_bubbles(img, pad_x * page_w / w, pad_y * page_h / h,
                            w / (w + 2 * pad_x), h / (h + 2 * pad_y))
        try:
            raw, final_marked, multi_marked, _ = ops.read_omr_response(
                self.template, image=img, name=name, save_dir=None)
        except Exception as exc:
            return SheetResult(ok=False, error_reason=f"could not read bubbles: {exc}")
        conc = get_concatenated_response(raw, self.template)
        fields = {k: (conc.get(k) or "").strip() for k in self.field_labels}
        answers = {k: (conc.get(k) or "").strip() for k in self.question_labels}

        reasons = []
        wanted = set(self.question_labels if questions is None else questions)
        doubled = [k for k, v in raw.items()
                   if str(v).strip() and str(v) not in self._single_values.get(k, {str(v)})]
        doubles = sorted((q for q in doubled if QUESTION_RE.match(q) and q in wanted and q not in several_ok),
                         key=lambda q: int(QUESTION_RE.match(q).group(1)))
        if doubles:
            reasons.append("two bubbles filled for " + ", ".join(doubles[:5]) + (" ..." if len(doubles) > 5 else ""))
        for label in sorted({self._field_of_part.get(k, k) for k in doubled if not QUESTION_RE.match(k)}):
            if label == "gender":
                reasons.append("both gender bubbles filled")
            else:
                reasons.append(f"two bubbles filled in a column of the {label.lower()}")
        if not fields.get("Name"):
            reasons.append("name is blank")
        elif not (raw.get("name1") or "").strip():
            # Names are written from the first column; a blank first column usually means
            # the scan lost a letter at the edge of the sheet.
            reasons.append("name does not start in the first column")
        if "Roll Number" in fields and not fields["Roll Number"]:
            reasons.append("roll number is blank")
        if "Mobile Number" in fields:
            short_mobile = mobile_digits_reason(fields["Mobile Number"])
            if short_mobile:
                reasons.append(short_mobile)

        ok, jpeg = cv2.imencode(".jpg", final_marked, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return SheetResult(
            ok=True, fields=fields, answers=answers,
            needs_review=bool(reasons), review_reason="; ".join(reasons),
            checked_image_jpeg=jpeg.tobytes() if ok else None,
            layout=self._layout(),
        )

    def evaluate(self, page: np.ndarray, answer_key: Dict[str, str], name: str = "sheet",
                 marks_correct: float = 1, marks_incorrect: float = 0, marks_unmarked: float = 0) -> SheetResult:
        result = self.read(page, name, questions=answer_key.keys(),
                           several_ok=[q for q, correct in answer_key.items() if needs_all(correct)])
        if result.ok:
            result.score = score_answers(result.answers, answer_key, marks_correct, marks_incorrect, marks_unmarked)
        return result
