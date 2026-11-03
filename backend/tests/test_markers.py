"""A faint corner marker is kept when it sits where the sheet's other three corners say it must."""
from omr.markers import corners_fit

FLAT_SCAN = [[30, 40], [630, 44], [28, 790], [634, 794]]


def test_a_near_rectangle_fits():
    assert corners_fit(FLAT_SCAN)


def test_a_phone_photo_with_a_little_keystone_fits():
    assert corners_fit([[30, 40], [625, 45], [20, 790], [640, 786]])


def test_a_corner_found_somewhere_else_does_not_fit():
    assert not corners_fit([[30, 40], [630, 44], [28, 790], [500, 700]])
    # A folded corner: the best match is a bubble well above the sheet's corner.
    assert not corners_fit([[30, 40], [630, 44], [28, 790], [634, 600]])


def test_a_landscape_or_degenerate_shape_does_not_fit():
    assert not corners_fit([[30, 40], [830, 44], [28, 500], [834, 504]])
    assert not corners_fit([[30, 40], [30, 40], [28, 790], [634, 794]])
