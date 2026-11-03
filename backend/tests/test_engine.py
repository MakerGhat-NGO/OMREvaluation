"""The per-scan grid fit that puts bubble windows on the circles a particular print run drew."""
import numpy as np

from omr.engine import circle_likeness, fit_grid_axis, mobile_digits_reason


def ink_profile_for_circles(centres, length=1000, radius=12):
    """Darkness along one axis of a row of printed circles, summed across the other axis:
    a band of ink the width of the circle (its outline and the letter inside), darker at
    the two edges where the outline runs along the axis."""
    profile = np.zeros(length, np.float32)
    for c in centres:
        lo, hi = int(c - radius), int(c + radius) + 1
        profile[max(lo, 0):hi] += 30
        profile[max(lo, 0):lo + 3] += 25
        profile[hi - 3:hi] += 25
    return profile


def test_finds_a_grid_that_is_shifted_and_stretched():
    # The first circle is cut off by the image edge, as on a tightly scanned sheet.
    true_start, true_pitch, count = 7.0, 33.6, 30
    profile = ink_profile_for_circles([true_start + i * true_pitch for i in range(count)])
    start, pitch = fit_grid_axis(profile, start=17.5, pitch=33.0, count=count, circle_radius=10)
    assert abs(start - true_start) <= 2.0        # a 25 px bubble window forgives this
    assert abs(pitch - true_pitch) <= 0.15


def test_keeps_a_grid_that_already_matches():
    profile = ink_profile_for_circles([17.5 + i * 33.0 for i in range(30)])
    start, pitch = fit_grid_axis(profile, start=17.5, pitch=33.0, count=30, circle_radius=10)
    assert abs(start - 17.5) <= 1.0
    assert abs(pitch - 33.0) <= 0.15


def test_filled_bubbles_do_not_pull_the_grid():
    centres = [17.5 + i * 33.0 for i in range(30)]
    profile = ink_profile_for_circles(centres)
    for c in (centres[3], centres[12]):       # two solid discs, as a student would fill
        profile[int(c) - 11:int(c) + 12] += 200
    start, pitch = fit_grid_axis(profile, start=17.5, pitch=33.0, count=30, circle_radius=10)
    assert abs(start - 17.5) <= 1.0
    assert abs(pitch - 33.0) <= 0.15


def test_a_mobile_number_with_missing_digits_is_flagged():
    assert mobile_digits_reason("") is None                  # not collected on this sheet
    assert mobile_digits_reason("9876500011") is None
    assert mobile_digits_reason("98765000112") is None       # a doubled column is reported on its own
    assert mobile_digits_reason("955269 742") == "mobile number has 9 digits, not 10"   # a column skipped
    assert mobile_digits_reason("3") == "mobile number has 1 digit, not 10"            # a stray mark


def test_a_row_of_boxes_is_no_row_of_circles():
    import cv2
    # A scan-like sheet: grey paper, ten columns 32 px apart. Row 1 is a row of pale, thin
    # printed circles (radius 10) with a digit in each, row 2 a row of filled circles, and
    # above them the row of boxes a student writes in: 32 x 24 rectangles sharing their
    # sides, two of them with a digit written in. Blurred a little, as a scan is.
    ink = np.full((130, 360), 40, np.uint8)
    columns = np.array([24.0 + 32 * i for i in range(10)])
    for x in columns:
        cv2.rectangle(ink, (int(x) - 16, 8), (int(x) + 16, 32), 160, 2)
        cv2.circle(ink, (int(x), 60), 10, 110, 1)
        cv2.putText(ink, "7", (int(x) - 5, 66), cv2.FONT_HERSHEY_SIMPLEX, 0.4, 110, 1)
        cv2.circle(ink, (int(x), 96), 10, 200, -1)
    for x in columns[:2]:
        cv2.putText(ink, "2", (int(x) - 6, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 170, 2)
    ink = cv2.GaussianBlur(ink, (5, 5), 0)
    likeness = circle_likeness(ink.astype(np.float32), columns, 10.0)
    assert likeness[60] > 0 and likeness[96] > 0
    # Far enough below zero for the row fit to count the boxes row as nothing (CIRCLE_GATE).
    assert likeness[20] < -0.5 * min(likeness[60], likeness[96])
