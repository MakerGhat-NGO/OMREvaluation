"""The rule that keeps a faint corner marker: it is the marker when it sits where the sheet's other
three corners say the corner must be. Kept apart from the processor so it can be tested on its own."""
import numpy as np

# A corner marker that is faint, curled or in a shadow can score well under the other three, and
# the stock rule rejects any corner more than 0.41 below the best, however clearly it is there.
# A corner that still reaches the usual minimum score is kept when it sits where the other three
# say the sheet's corner must be: on every readable sheet seen so far (flat scans and phone
# photos) the four centres make a near-rectangle, opposite sides within 6% of each other,
# diagonals within 5%, width 0.65 to 0.95 of the height, while the best match for a missing or
# folded corner lands somewhere else. A corner below the minimum score is never kept: its match
# can be a few pixels off even when the shape fits, and the sheet then reads wrongly.
SIDE_RATIO_MIN = 0.94
DIAGONAL_RATIO_MIN = 0.95
ASPECT_RANGE = (0.65, 0.95)


def corners_fit(centres):
    """Whether four marker centres (top-left, top-right, bottom-left, bottom-right) make the
    near-rectangle that a scanned or photographed sheet always makes."""
    tl, tr, bl, br = (np.array(c, np.float32) for c in centres)
    top, bottom = np.linalg.norm(tr - tl), np.linalg.norm(br - bl)
    left, right = np.linalg.norm(bl - tl), np.linalg.norm(br - tr)
    d1, d2 = np.linalg.norm(br - tl), np.linalg.norm(bl - tr)
    if min(top, bottom, left, right, d1, d2) <= 0:
        return False
    width, height = (top + bottom) / 2, (left + right) / 2
    return (
        min(top, bottom) / max(top, bottom) >= SIDE_RATIO_MIN
        and min(left, right) / max(left, right) >= SIDE_RATIO_MIN
        and min(d1, d2) / max(d1, d2) >= DIAGONAL_RATIO_MIN
        and ASPECT_RANGE[0] <= width / height <= ASPECT_RANGE[1]
    )
