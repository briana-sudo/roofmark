"""
================================================================================
kcc-shop-drawing.py — KCC RoofMark Locked Shop Drawing Template
================================================================================

Status      : LOCKED — v1.1 — May 12 2026
Authority   : Approved title block layout draft v3 (Webster Groves session)
              + 18h decision-flag pass May 12 2026 (Brian, locked).
Spec        : RoofMark Kickoff Spec v1.0, Section 21 — Technical Drawing Mode
              https://www.notion.so/33eca70abea681668644c1dc03228839
18h spec    : https://www.notion.so/35eca70abea68142854ad4c62cb5dab1
Branding    : KCC Operational Standards — navy / orange / Arial-equivalent
              https://www.notion.so/33dca70abea681c48ce8ff448587bfe4

Purpose
-------
Single-pass shop drawing PDF producer. A Claude thread reads a RoofMark
Technical Drawing JSON export, calls render_shop_drawing(data, out_dir),
and gets back a finished, fabricator-ready PDF. No layout iteration. No
template variables. Every position, font size, color, and proportion is a
hardcoded constant in this file.

v1.0 → v1.1 changes
-------------------
v1.1 adds 4 OPTIONAL input fields. When omitted, v1.1 produces output
visually identical to v1.0 (regression-safe per 18h locked decision D11):
- pageOrientation: 'landscape' (default) | 'portrait'
- geometryRotation: 0 (default) | 90 | 180 | 270  (degrees clockwise)
- fitMode: 'auto' (default) | '1:1' | 'custom'
- customScale: number > 0 (default 1.0, used only when fitMode == 'custom')

Reference-PDF alignment (CLIENT / STATUS / PROFILE-description / REV /
SHEET / notes block / length-into-page callout / finish callout) is
OUT OF SCOPE for v1.1. Visual style is unchanged.

Input contract
--------------
data = {
    "specTable": {
        "partName":     str,   # required
        "material":     str,   # required
        "color":        str,
        "stockLength":  str,
        "jobId":        str,
        "jobAddress":   str,
        "drawnBy":      str,
        "date":         str,   # ISO YYYY-MM-DD or human format, used as-is
        "drawingNo":    str,   # required — format [jobId]-NNN, e.g. KCC-2026-003-001
    },
    "layers": [
        {
            "name":       str,
            "color":      str,                 # hex, e.g. "#374151"
            "order":      int,                 # 0 = bottom, drawn first
            "shapes":     [ shape, ... ],
            "dimensions": [ dim, ... ],
            "callouts":   [ callout, ... ],
        },
        ...
    ],
    "drawingType":     "profile" | "assembly_stack",
    "internalScale":   24,                     # px per inch — fixed, never changes

    # v1.1 (May 12 2026) — all 4 optional:
    "pageOrientation": "landscape" | "portrait",   # default "landscape"
    "geometryRotation": 0 | 90 | 180 | 270,        # default 0, degrees CW
    "fitMode":         "auto" | "1:1" | "custom",  # default "auto"
    "customScale":     number > 0,                 # default 1.0, used only when fitMode == "custom"
}

Shape object
------------
Same as RoofMark canvas shape (unchanged in v1.1):
    { "id": str, "type": "poly"|"tri"|"rect"|"circ"|"line",
      "pts": [{"x": float, "y": float}, ...]   # used by poly/tri/rect/line
      "cx": float, "cy": float, "r": float,    # circ only
      "fillOpacity": float|None, "strokeOpacity": float|None,
      "strokeWeight": float|None, "fillOn": bool|None, "strokeOn": bool|None }

Dimension object
----------------
    { "id": str, "x1": float, "y1": float, "x2": float, "y2": float,
      "value": str }     # auto-computed at export, may be overridden by user

Callout object
--------------
    { "id": str, "tipX": float, "tipY": float, "tailX": float, "tailY": float,
      "num": int, "textEN": str }

Output
------
PDF written to:  out_dir / [drawingNo]_[partName-slug].pdf
Filename pattern is UNCHANGED across orientation / rotation / fitMode
(decision D12). PDF page geometry differs.

Page format
-----------
Default landscape letter (11.0in x 8.5in = 792pt x 612pt). Portrait
selected via pageOrientation == 'portrait' switches to 8.5in x 11.0in
(612pt x 792pt) with 2-cols × 4-rows spec table per decision D7.

================================================================================
"""

from __future__ import annotations
import os
import re
from pathlib import Path

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter, landscape, portrait
from reportlab.lib.colors import HexColor, white, black, Color


# =============================================================================
# LOCKED LAYOUT CONSTANTS — DO NOT EDIT WITHOUT A NEW DESIGN SESSION
#
# These module-level constants document the v1.0 LANDSCAPE layout. v1.1
# computes a per-orientation layout dict in `_layout(orientation)` below
# which mirrors these values for landscape and re-flows for portrait per
# 18h decision D7 (2 cols × 4 rows spec table) and D8 (138 pt spec table
# height). Renderer reads from the dict, NOT these constants.
# =============================================================================

# ---- Page (landscape default) ----------------------------------------------
PAGE_W = 792.0     # 11.0 in
PAGE_H = 612.0     # 8.5 in

# ---- Brand colors (orientation-independent) --------------------------------
KCC_NAVY        = HexColor("#1A2F4A")
KCC_ORANGE      = HexColor("#E8630A")
LIGHT_GRAY_BG   = HexColor("#ECEEF2")
GRID_LIGHT      = HexColor("#C8D8E8")
SPEC_TABLE_BG   = HexColor("#F5F6F8")
TEXT_DIM        = HexColor("#666666")
HEADER_SUB_TEXT = HexColor("#C8D8E8")
DIM_AMBER       = HexColor("#B8860B")   # dimension labels (print-friendly amber)

# ---- Sheet frame (orientation-independent magnitudes) ----------------------
MARGIN          = 25.2     # 0.35 in — perimeter inset
SHEET_BORDER_SW = 1.0      # navy perimeter line weight

# ---- Header bar (orientation-independent heights) --------------------------
HEADER_H        = 39.6     # 0.55 in
HDR_LEFT_PAD    = 14.4     # 0.20 in
HDR_RIGHT_PAD   = 14.4     # 0.20 in

HDR_L_PRIMARY_FONT    = "Helvetica-Bold"
HDR_L_PRIMARY_SIZE    = 13
HDR_L_PRIMARY_COLOR   = white
HDR_L_PRIMARY_TEXT    = "KOSAREK CONSTRUCTION CO."

HDR_L_SECONDARY_FONT  = "Helvetica"
HDR_L_SECONDARY_SIZE  = 7.5
HDR_L_SECONDARY_COLOR = HEADER_SUB_TEXT
HDR_L_SECONDARY_TEXT  = "Illinois Unlimited Roofing License  |  Engineered Roofing Precision"

HDR_R_LABEL_FONT      = "Helvetica-Bold"
HDR_R_LABEL_SIZE      = 8
HDR_R_LABEL_COLOR     = KCC_ORANGE
HDR_R_LABEL_TEXT      = "SHOP DRAWING"

HDR_R_DWGNO_FONT      = "Helvetica-Bold"
HDR_R_DWGNO_SIZE      = 15
HDR_R_DWGNO_COLOR     = white

# ---- Orange accent stripe --------------------------------------------------
ACCENT_H        = 4.3      # 0.06 in

# ---- Footer bar ------------------------------------------------------------
FOOTER_H        = 21.6     # 0.30 in

FTR_LEFT_FONT   = "Helvetica-Bold"
FTR_LEFT_SIZE   = 7
FTR_LEFT_COLOR  = white
FTR_LEFT_TEXT   = "KCC ROOFMARK  |  AEROSPACE-GRADE PROCESS DISCIPLINE FOR ROOFING"

FTR_RIGHT_FONT  = "Helvetica"
FTR_RIGHT_SIZE  = 7
FTR_RIGHT_COLOR = HEADER_SUB_TEXT
# v1.0 → v1.1: footer right text updated to reflect script version.
FTR_RIGHT_TEXT  = "kcc-shop-drawing.py v1.1  |  internal scale 24 px / inch"

# ---- Spec table — landscape layout (4 cols × 2 rows) -----------------------
SPEC_TABLE_H_LANDSCAPE = 75.6    # 1.05 in
ST_BAR_H        = 12.96          # 0.18 in
ST_BAR_TEXT_OFFSET_RATIO = 0.30  # text y relative to bar height

ST_BAR_L_FONT   = "Helvetica-Bold"
ST_BAR_L_SIZE   = 8
ST_BAR_L_COLOR  = white
ST_BAR_L_TEXT   = "PART  &  JOB  SPECIFICATION"

ST_BAR_R_FONT   = "Helvetica-Oblique"
ST_BAR_R_SIZE   = 7
ST_BAR_R_COLOR  = HEADER_SUB_TEXT
ST_BAR_R_TEXT   = "KCC RoofMark — Locked Title Block"

SPEC_DIVIDER_SW = 0.4

# Field order, row-major. 9th field (drawingNo) lives in the header
# (decision D9 — unchanged from v1.0).
SPEC_FIELDS = (
    ("PART NAME",     "partName"),
    ("MATERIAL",      "material"),
    ("COLOR",         "color"),
    ("STOCK LENGTH",  "stockLength"),
    ("JOB ID",        "jobId"),
    ("JOB ADDRESS",   "jobAddress"),
    ("DRAWN BY",      "drawnBy"),
    ("DATE",          "date"),
)

SPEC_LABEL_PAD_X     = 8
SPEC_LABEL_OFFSET_Y  = 11   # below cell top
SPEC_LABEL_FONT      = "Helvetica-Bold"
SPEC_LABEL_SIZE      = 7
SPEC_LABEL_COLOR     = KCC_ORANGE

SPEC_VALUE_FONT      = "Helvetica"
SPEC_VALUE_SIZE      = 9
SPEC_VALUE_COLOR     = KCC_NAVY
SPEC_VALUE_PAD_X     = 8
SPEC_VALUE_OFFSET_Y  = 8    # above cell bottom

# ---- Spec table — portrait layout (2 cols × 4 rows per decision D7) --------
# Total height 138 pt = navy stripe 12.96 + 4 rows × 31.26 (decision D8).
SPEC_TABLE_H_PORTRAIT = 138.0
SPEC_ROW_H_PORTRAIT   = 31.26    # matches landscape row height to within 0.06 pt

# ---- Drawing area ----------------------------------------------------------
DRAW_TOP_PAD    = 7.2      # 0.10 in
DRAW_BOT_PAD    = 7.2      # 0.10 in
DRAW_SIDE_PAD   = 7.2

DRAW_BORDER_SW  = 0.5
DRAW_GRID_SPACING = 36.0   # 0.5 in faint grid lines
DRAW_GRID_SW    = 0.25

# Corner crosshairs (orange) on drawing area
CROSSHAIR_LEN   = 10
CROSSHAIR_SW    = 1.0

# Auto-fit scaling margin (inside drawing area) — reserves space for
# dimension lines and labels. Used by both 'auto' and overflow checks
# for '1:1' / 'custom'.
DRAW_FIT_MARGIN = 18.0     # pt

# ---- Geometry rendering ----------------------------------------------------
DEFAULT_FILL_OPACITY    = 0.25
DEFAULT_STROKE_OPACITY  = 1.0
DEFAULT_STROKE_WEIGHT   = 1.6
DEFAULT_FILL_ON         = True
DEFAULT_STROKE_ON       = True

# Dimension line styling
DIM_EXTENSION_OFFSET    = 14.0
DIM_LINE_SW             = 0.8
DIM_ARROW_LEN           = 6.0
DIM_ARROW_HALF_W        = 2.5
DIM_LABEL_FONT          = "Helvetica-Bold"
DIM_LABEL_SIZE          = 8
DIM_LABEL_PAD           = 3.0
DIM_LABEL_BG_PAD        = 2.0

# Callout styling
CALLOUT_TIP_R           = 8.0
CALLOUT_TIP_FILL        = KCC_ORANGE
CALLOUT_TIP_STROKE      = white
CALLOUT_TIP_STROKE_SW   = 1.2
CALLOUT_NUM_FONT        = "Helvetica-Bold"
CALLOUT_NUM_SIZE        = 9
CALLOUT_NUM_COLOR       = white
CALLOUT_LEADER_SW       = 0.8
CALLOUT_LEADER_COLOR    = KCC_NAVY
CALLOUT_TEXT_FONT       = "Helvetica"
CALLOUT_TEXT_SIZE       = 8
CALLOUT_TEXT_COLOR      = KCC_NAVY
CALLOUT_BOX_FILL        = white
CALLOUT_BOX_STROKE      = KCC_ORANGE
CALLOUT_BOX_SW          = 0.6
CALLOUT_BOX_PAD_X       = 5.0
CALLOUT_BOX_PAD_Y       = 3.0

# Layer label (assembly stack mode)
LAYER_LABEL_FONT        = "Helvetica-Bold"
LAYER_LABEL_SIZE        = 7.5

# v1.1 (18h decision D2) — 1:1 scale interpretation: real-world.
# 24 JSON pixels = 1 inch on paper = 72 PDF points. So pixel→point
# scale at 1:1 is 72.0 / 24.0 = 3.0.
ONE_TO_ONE_SCALE = 72.0 / 24.0   # = 3.0


# =============================================================================
# v1.1 — LAYOUT FUNCTION
#
# Returns a dict of all positional constants for the requested orientation.
# Per 18h IMPLEMENTATION NOTES §2: renderer pulls from this dict rather
# than the module-level constants, so portrait re-flow is data-driven.
# Module-level constants stay as v1.0-landscape fallback documentation.
# =============================================================================

def _layout(orientation: str) -> dict:
    """Build the positional-constant dict for the requested page orientation.

    Decisions D7 + D8 (May 12 2026): portrait spec table is 2 cols × 4 rows,
    138 pt tall. All other vertical components (header, accent, footer)
    keep their landscape heights; the drawing area absorbs the
    orientation-driven slack.
    """
    if orientation == "portrait":
        page_w, page_h = 612.0, 792.0
        spec_table_h = SPEC_TABLE_H_PORTRAIT
        spec_cols = 2
        spec_rows = 4
    else:
        # 'landscape' (default + v1.0 behavior)
        page_w, page_h = 792.0, 612.0
        spec_table_h = SPEC_TABLE_H_LANDSCAPE
        spec_cols = 4
        spec_rows = 2

    sheet_x0 = MARGIN
    sheet_y0 = MARGIN
    sheet_x1 = page_w - MARGIN
    sheet_y1 = page_h - MARGIN

    hdr_y1   = sheet_y1
    hdr_y0   = hdr_y1 - HEADER_H

    acc_y1   = hdr_y0
    acc_y0   = acc_y1 - ACCENT_H

    ftr_y0   = sheet_y0
    ftr_y1   = ftr_y0 + FOOTER_H

    spec_y0  = ftr_y1
    spec_y1  = spec_y0 + spec_table_h

    st_bar_y0 = spec_y1 - ST_BAR_H
    st_bar_y1 = spec_y1

    spec_grid_y0 = spec_y0
    spec_grid_y1 = st_bar_y0
    spec_col_w = (sheet_x1 - sheet_x0) / spec_cols
    spec_row_h = (spec_grid_y1 - spec_grid_y0) / spec_rows

    draw_x0 = sheet_x0 + DRAW_SIDE_PAD
    draw_x1 = sheet_x1 - DRAW_SIDE_PAD
    draw_y0 = spec_y1 + DRAW_BOT_PAD
    draw_y1 = acc_y0  - DRAW_TOP_PAD

    return {
        "orientation":   orientation,
        "page_w":        page_w,
        "page_h":        page_h,
        "sheet_x0":      sheet_x0,
        "sheet_y0":      sheet_y0,
        "sheet_x1":      sheet_x1,
        "sheet_y1":      sheet_y1,
        "hdr_y0":        hdr_y0,
        "hdr_y1":        hdr_y1,
        "acc_y0":        acc_y0,
        "acc_y1":        acc_y1,
        "ftr_y0":        ftr_y0,
        "ftr_y1":        ftr_y1,
        "spec_y0":       spec_y0,
        "spec_y1":       spec_y1,
        "spec_table_h":  spec_table_h,
        "st_bar_y0":     st_bar_y0,
        "st_bar_y1":     st_bar_y1,
        "spec_cols":     spec_cols,
        "spec_rows":     spec_rows,
        "spec_grid_y0":  spec_grid_y0,
        "spec_grid_y1":  spec_grid_y1,
        "spec_col_w":    spec_col_w,
        "spec_row_h":    spec_row_h,
        "draw_x0":       draw_x0,
        "draw_x1":       draw_x1,
        "draw_y0":       draw_y0,
        "draw_y1":       draw_y1,
    }


# =============================================================================
# v1.1 — INPUT VALIDATION
# =============================================================================

_VALID_ORIENTATIONS = ("landscape", "portrait")
_VALID_ROTATIONS = (0, 90, 180, 270)
_VALID_FIT_MODES = ("auto", "1:1", "custom")


def _validate_v11_inputs(data: dict):
    """Raise ValueError on any malformed v1.1 input. Missing fields fall
    to defaults silently. Type mismatches do NOT coerce (decision D11
    regression contract requires explicit failure)."""
    # pageOrientation
    if "pageOrientation" in data:
        po = data["pageOrientation"]
        if po not in _VALID_ORIENTATIONS:
            raise ValueError(
                f"pageOrientation must be one of {_VALID_ORIENTATIONS}, "
                f"got {po!r}"
            )

    # geometryRotation
    if "geometryRotation" in data:
        gr = data["geometryRotation"]
        # Reject booleans and non-int types explicitly.
        # isinstance(True, int) is True in Python, so guard against bool first.
        if isinstance(gr, bool) or not isinstance(gr, int) or gr not in _VALID_ROTATIONS:
            raise ValueError(
                f"geometryRotation must be one of {_VALID_ROTATIONS}, "
                f"got {gr!r}"
            )

    # fitMode
    if "fitMode" in data:
        fm = data["fitMode"]
        if fm not in _VALID_FIT_MODES:
            raise ValueError(
                f"fitMode must be one of {_VALID_FIT_MODES}, got {fm!r}"
            )

    # customScale — only validate when fitMode is 'custom'. Per decision D6
    # customScale must be a number > 0 (reject 0, negative, None, strings).
    # When fitMode != 'custom', customScale is ignored silently.
    if data.get("fitMode") == "custom":
        cs = data.get("customScale", 1.0)
        if isinstance(cs, bool) or not isinstance(cs, (int, float)) or cs <= 0:
            raise ValueError(
                f"customScale must be a positive number when "
                f"fitMode='custom', got {cs!r}"
            )


# =============================================================================
# v1.1 — GEOMETRY ROTATION
# =============================================================================

def _rotate_geometry(data: dict, degrees: int) -> dict:
    """Pre-rotate all geometry points around the bbox centroid before
    auto-fit / 1:1 / custom-scale runs (decision D10).

    Screen-y-down convention (RoofMark canvas convention):
        90° CW :  (x, y) → (cx + (y - cy), cy - (x - cx))
        180°   :  (x, y) → (2*cx - x,       2*cy - y)
        270° CW:  (x, y) → (cx - (y - cy), cy + (x - cx))
        0°     :  no-op

    Validated at input pre-pass; here we assume `degrees` is one of
    {0, 90, 180, 270}. Returns a deep-copied data dict; original is
    not mutated.
    """
    if degrees == 0:
        return data

    # Deep-copy only the geometry portion. specTable + top-level fields
    # are shared by reference (immutable strings/numbers — safe).
    from copy import deepcopy
    data = deepcopy(data)
    layers = data.get("layers") or []
    if not layers:
        return data

    # Compute centroid from pre-rotation bbox of all geometry points.
    bbox = _compute_bbox(layers)
    if bbox is None:
        return data
    bx0, by0, bx1, by1 = bbox
    cx = (bx0 + bx1) / 2
    cy = (by0 + by1) / 2

    def rot(x, y):
        if degrees == 90:
            return (cx + (y - cy), cy - (x - cx))
        if degrees == 180:
            return (2 * cx - x, 2 * cy - y)
        # degrees == 270
        return (cx - (y - cy), cy + (x - cx))

    for layer in layers:
        for sh in layer.get("shapes", []) or []:
            if sh.get("type") == "circ":
                nx, ny = rot(sh.get("cx", 0), sh.get("cy", 0))
                sh["cx"] = nx
                sh["cy"] = ny
                # Radius rotation-invariant
            else:
                for p in sh.get("pts", []) or []:
                    nx, ny = rot(p.get("x", 0), p.get("y", 0))
                    p["x"] = nx
                    p["y"] = ny
        for d in layer.get("dimensions", []) or []:
            nx1, ny1 = rot(d.get("x1", 0), d.get("y1", 0))
            nx2, ny2 = rot(d.get("x2", 0), d.get("y2", 0))
            d["x1"] = nx1; d["y1"] = ny1
            d["x2"] = nx2; d["y2"] = ny2
        for ca in layer.get("callouts", []) or []:
            tipx, tipy = rot(ca.get("tipX", 0), ca.get("tipY", 0))
            tailx, taily = rot(ca.get("tailX", 0), ca.get("tailY", 0))
            ca["tipX"] = tipx; ca["tipY"] = tipy
            ca["tailX"] = tailx; ca["tailY"] = taily

    return data


# =============================================================================
# v1.1 — FIT-MODE SCALE COMPUTATION
# =============================================================================

def _compute_fit_scale(bbox, layout, fit_mode: str, custom_scale: float):
    """Return (scale, tx, ty) for the requested fit mode.

    Decisions:
        D2  — 1:1 == real-world: scale = 72/24 = 3.0
        D3  — 1:1 overflow: fail loudly with ValueError
        D4  — Custom overflow: fail loudly with ValueError
        D5  — Rotation happens BEFORE this function. The bbox passed in
              is already the rotated bbox.

    `bbox` is (bx0, by0, bx1, by1) in JSON pixel space.
    `layout` is the dict from _layout(orientation).
    """
    bx0, by0, bx1, by1 = bbox
    bw = max(bx1 - bx0, 1e-6)
    bh = max(by1 - by0, 1e-6)

    fit_x0 = layout["draw_x0"] + DRAW_FIT_MARGIN
    fit_y0 = layout["draw_y0"] + DRAW_FIT_MARGIN
    fit_x1 = layout["draw_x1"] - DRAW_FIT_MARGIN
    fit_y1 = layout["draw_y1"] - DRAW_FIT_MARGIN
    fw = fit_x1 - fit_x0
    fh = fit_y1 - fit_y0

    if fit_mode == "auto":
        scale = min(fw / bw, fh / bh)
    elif fit_mode == "1:1":
        scale = ONE_TO_ONE_SCALE
        _check_fit_overflow(bw, bh, scale, fw, fh, fit_mode)
    elif fit_mode == "custom":
        scale = ONE_TO_ONE_SCALE * float(custom_scale)
        _check_fit_overflow(bw, bh, scale, fw, fh, fit_mode)
    else:
        # Validated at pre-pass; defensive fallback.
        scale = min(fw / bw, fh / bh)

    # Center the scaled bbox inside the fit area. JSON-y-down → PDF-y-up
    # flip happens here, unchanged from v1.0.
    tx = fit_x0 + (fw - bw * scale) / 2 - bx0 * scale
    ty = fit_y1 - (fh - bh * scale) / 2 + by0 * scale
    return scale, tx, ty


def _check_fit_overflow(bw, bh, scale, fw, fh, fit_mode):
    """Raise ValueError if scaled bbox exceeds drawing fit region.
    Decisions D3 + D4 — fail loudly, name the dimensions."""
    sw = bw * scale
    sh = bh * scale
    if sw > fw or sh > fh:
        raise ValueError(
            f"Geometry at fitMode={fit_mode!r} exceeds drawing area: "
            f"required {sw:.1f}x{sh:.1f} pt, "
            f"available {fw:.1f}x{fh:.1f} pt. "
            f"Choose fitMode='auto', reduce customScale, or rotate geometry."
        )


# =============================================================================
# RENDER FUNCTION
# =============================================================================

def render_shop_drawing(data: dict, out_dir: str | os.PathLike = ".") -> str:
    """Produce the locked KCC shop drawing PDF from a RoofMark Technical
    Drawing export dict. Returns absolute path of the written PDF."""

    # ---- v1.1 input validation pre-pass (raises ValueError on bad input)
    _validate_v11_inputs(data)

    spec = data.get("specTable") or {}
    layers = data.get("layers") or []
    drawing_type = (data.get("drawingType") or "profile").lower()
    internal_scale = float(data.get("internalScale") or 24.0)  # documented, unused in math

    # v1.1 new fields with defaults
    orientation = data.get("pageOrientation", "landscape")
    rotation_deg = int(data.get("geometryRotation", 0))
    fit_mode = data.get("fitMode", "auto")
    custom_scale = float(data.get("customScale", 1.0))

    # ---- validate required spec fields --------------------------------------
    for required in ("partName", "material", "drawingNo"):
        if not str(spec.get(required) or "").strip():
            raise ValueError(
                f"specTable.{required} is required and was empty. "
                f"Got specTable={spec!r}"
            )

    drawing_no = str(spec["drawingNo"]).strip()
    part_name  = str(spec["partName"]).strip()

    # ---- compute output filename (decision D12 — pattern unchanged) --------
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{_slug(drawing_no)}_{_slug(part_name)}.pdf"
    out_path = (out_dir / fname).resolve()

    # ---- v1.1 ordered pipeline ---------------------------------------------
    # 1. Validate inputs (above).
    # 2. Rotate geometry (decision D10 — before bbox/fit).
    rotated = _rotate_geometry(data, rotation_deg)
    rotated_layers = rotated.get("layers") or []

    # 3. Compute layout dict for orientation (decision D7).
    layout = _layout(orientation)

    # ---- canvas (orientation drives page size + page_size argument) --------
    if orientation == "portrait":
        page_size = portrait(letter)
    else:
        page_size = landscape(letter)
    c = canvas.Canvas(str(out_path), pagesize=page_size)
    c.setTitle(f"KCC Shop Drawing {drawing_no} - {part_name}")
    c.setAuthor("Kosarek Construction Company")
    c.setSubject(f"Drawing type: {drawing_type}")
    c.setCreator("kcc-shop-drawing.py v1.1")

    # ---- render in fixed order ---------------------------------------------
    _draw_page_background(c, layout)
    _draw_sheet_border(c, layout)
    _draw_header(c, layout, drawing_no)
    _draw_accent_stripe(c, layout)
    _draw_footer(c, layout)
    _draw_spec_table(c, layout, spec)
    _draw_drawing_area_frame(c, layout)
    _draw_geometry(c, layout, rotated_layers, drawing_type, fit_mode, custom_scale)

    c.save()
    return str(out_path)


# =============================================================================
# DRAW HELPERS — title block (layout-dict driven)
# =============================================================================

def _draw_page_background(c, lay):
    c.setFillColor(LIGHT_GRAY_BG)
    c.rect(0, 0, lay["page_w"], lay["page_h"], fill=1, stroke=0)


def _draw_sheet_border(c, lay):
    c.setStrokeColor(KCC_NAVY)
    c.setLineWidth(SHEET_BORDER_SW)
    c.rect(lay["sheet_x0"], lay["sheet_y0"],
           lay["sheet_x1"] - lay["sheet_x0"],
           lay["sheet_y1"] - lay["sheet_y0"], fill=0, stroke=1)


def _draw_header(c, lay, drawing_no: str):
    hdr_y0 = lay["hdr_y0"]
    sheet_x0 = lay["sheet_x0"]
    sheet_x1 = lay["sheet_x1"]
    width = sheet_x1 - sheet_x0

    # Navy header bar
    c.setFillColor(KCC_NAVY)
    c.rect(sheet_x0, hdr_y0, width, HEADER_H, fill=1, stroke=0)

    # LEFT — primary
    c.setFillColor(HDR_L_PRIMARY_COLOR)
    c.setFont(HDR_L_PRIMARY_FONT, HDR_L_PRIMARY_SIZE)
    c.drawString(sheet_x0 + HDR_LEFT_PAD,
                 hdr_y0 + HEADER_H * 0.58,
                 HDR_L_PRIMARY_TEXT)

    # LEFT — secondary
    c.setFillColor(HDR_L_SECONDARY_COLOR)
    c.setFont(HDR_L_SECONDARY_FONT, HDR_L_SECONDARY_SIZE)
    c.drawString(sheet_x0 + HDR_LEFT_PAD,
                 hdr_y0 + HEADER_H * 0.20,
                 HDR_L_SECONDARY_TEXT)

    # RIGHT — small label "SHOP DRAWING" (orange)
    c.setFillColor(HDR_R_LABEL_COLOR)
    c.setFont(HDR_R_LABEL_FONT, HDR_R_LABEL_SIZE)
    c.drawRightString(sheet_x1 - HDR_RIGHT_PAD,
                      hdr_y0 + HEADER_H * 0.62,
                      HDR_R_LABEL_TEXT)

    # RIGHT — primary identifier (drawing number, white, large). Decision D9.
    c.setFillColor(HDR_R_DWGNO_COLOR)
    c.setFont(HDR_R_DWGNO_FONT, HDR_R_DWGNO_SIZE)
    c.drawRightString(sheet_x1 - HDR_RIGHT_PAD,
                      hdr_y0 + HEADER_H * 0.18,
                      drawing_no)


def _draw_accent_stripe(c, lay):
    c.setFillColor(KCC_ORANGE)
    c.rect(lay["sheet_x0"], lay["acc_y0"],
           lay["sheet_x1"] - lay["sheet_x0"], ACCENT_H, fill=1, stroke=0)


def _draw_footer(c, lay):
    sheet_x0 = lay["sheet_x0"]
    sheet_x1 = lay["sheet_x1"]
    ftr_y0 = lay["ftr_y0"]
    width = sheet_x1 - sheet_x0
    text_y = ftr_y0 + FOOTER_H * 0.32

    c.setFillColor(KCC_NAVY)
    c.rect(sheet_x0, ftr_y0, width, FOOTER_H, fill=1, stroke=0)

    c.setFillColor(FTR_LEFT_COLOR)
    c.setFont(FTR_LEFT_FONT, FTR_LEFT_SIZE)
    c.drawString(sheet_x0 + HDR_LEFT_PAD, text_y, FTR_LEFT_TEXT)

    c.setFillColor(FTR_RIGHT_COLOR)
    c.setFont(FTR_RIGHT_FONT, FTR_RIGHT_SIZE)
    c.drawRightString(sheet_x1 - HDR_RIGHT_PAD, text_y, FTR_RIGHT_TEXT)


def _draw_spec_table(c, lay, spec: dict):
    sheet_x0 = lay["sheet_x0"]
    sheet_x1 = lay["sheet_x1"]
    spec_y0 = lay["spec_y0"]
    st_bar_y0 = lay["st_bar_y0"]
    spec_cols = lay["spec_cols"]
    spec_rows = lay["spec_rows"]
    spec_col_w = lay["spec_col_w"]
    spec_row_h = lay["spec_row_h"]
    spec_grid_y0 = lay["spec_grid_y0"]
    spec_grid_y1 = lay["spec_grid_y1"]
    width = sheet_x1 - sheet_x0

    # Body fill
    c.setFillColor(SPEC_TABLE_BG)
    c.setStrokeColor(KCC_NAVY)
    c.setLineWidth(0.75)
    c.rect(sheet_x0, spec_y0, width, lay["spec_table_h"], fill=1, stroke=1)

    # Top stripe
    c.setFillColor(KCC_NAVY)
    c.rect(sheet_x0, st_bar_y0, width, ST_BAR_H, fill=1, stroke=0)

    st_bar_text_y = st_bar_y0 + ST_BAR_H * ST_BAR_TEXT_OFFSET_RATIO
    c.setFillColor(ST_BAR_L_COLOR)
    c.setFont(ST_BAR_L_FONT, ST_BAR_L_SIZE)
    c.drawString(sheet_x0 + HDR_LEFT_PAD, st_bar_text_y, ST_BAR_L_TEXT)

    c.setFillColor(ST_BAR_R_COLOR)
    c.setFont(ST_BAR_R_FONT, ST_BAR_R_SIZE)
    c.drawRightString(sheet_x1 - HDR_RIGHT_PAD, st_bar_text_y, ST_BAR_R_TEXT)

    # Grid dividers
    c.setStrokeColor(KCC_NAVY)
    c.setLineWidth(SPEC_DIVIDER_SW)
    for i in range(1, spec_cols):
        xv = sheet_x0 + i * spec_col_w
        c.line(xv, spec_grid_y0, xv, spec_grid_y1)
    for j in range(1, spec_rows):
        yh = spec_grid_y0 + j * spec_row_h
        c.line(sheet_x0, yh, sheet_x1, yh)

    # Field labels + values (row-major; index → row = i // spec_cols)
    for idx, (label, key) in enumerate(SPEC_FIELDS):
        row = idx // spec_cols
        col = idx %  spec_cols
        cell_x0 = sheet_x0 + col * spec_col_w
        cell_y1 = spec_grid_y1 - row * spec_row_h
        cell_y0 = cell_y1 - spec_row_h

        # Label
        c.setFillColor(SPEC_LABEL_COLOR)
        c.setFont(SPEC_LABEL_FONT, SPEC_LABEL_SIZE)
        c.drawString(cell_x0 + SPEC_LABEL_PAD_X,
                     cell_y1 - SPEC_LABEL_OFFSET_Y,
                     label)

        # Value (truncated to fit cell width)
        value_text = _format_spec_value(spec.get(key))
        max_w = spec_col_w - 2 * SPEC_VALUE_PAD_X
        value_text = _ellipsize(c, value_text, SPEC_VALUE_FONT, SPEC_VALUE_SIZE, max_w)

        c.setFillColor(SPEC_VALUE_COLOR)
        c.setFont(SPEC_VALUE_FONT, SPEC_VALUE_SIZE)
        c.drawString(cell_x0 + SPEC_VALUE_PAD_X,
                     cell_y0 + SPEC_VALUE_OFFSET_Y,
                     value_text)


def _draw_drawing_area_frame(c, lay):
    draw_x0 = lay["draw_x0"]
    draw_x1 = lay["draw_x1"]
    draw_y0 = lay["draw_y0"]
    draw_y1 = lay["draw_y1"]

    # White interior + faint border
    c.setFillColor(white)
    c.setStrokeColor(GRID_LIGHT)
    c.setLineWidth(DRAW_BORDER_SW)
    c.rect(draw_x0, draw_y0, draw_x1 - draw_x0, draw_y1 - draw_y0, fill=1, stroke=1)

    # Faint blueprint grid
    c.setStrokeColor(GRID_LIGHT)
    c.setLineWidth(DRAW_GRID_SW)
    x = draw_x0
    while x < draw_x1:
        c.line(x, draw_y0, x, draw_y1)
        x += DRAW_GRID_SPACING
    y = draw_y0
    while y < draw_y1:
        c.line(draw_x0, y, draw_x1, y)
        y += DRAW_GRID_SPACING

    # Orange corner crosshairs
    c.setStrokeColor(KCC_ORANGE)
    c.setLineWidth(CROSSHAIR_SW)
    for (cx, cy) in ((draw_x0, draw_y0), (draw_x1, draw_y0),
                     (draw_x0, draw_y1), (draw_x1, draw_y1)):
        c.line(cx - CROSSHAIR_LEN, cy, cx + CROSSHAIR_LEN, cy)
        c.line(cx, cy - CROSSHAIR_LEN, cx, cy + CROSSHAIR_LEN)


# =============================================================================
# DRAW HELPERS — geometry (fit + render layers/dimensions/callouts)
# =============================================================================

def _draw_geometry(c, lay, layers: list, drawing_type: str, fit_mode: str, custom_scale: float):
    """Compute fit transform, then render bottom-to-top by layer.order."""
    if not layers:
        # No geometry — placeholder text centered in drawing area
        c.setFillColor(TEXT_DIM)
        c.setFont("Helvetica-Oblique", 9)
        c.drawCentredString((lay["draw_x0"] + lay["draw_x1"]) / 2,
                            (lay["draw_y0"] + lay["draw_y1"]) / 2,
                            "(no geometry in JSON)")
        return

    bbox = _compute_bbox(layers)
    if bbox is None:
        return

    # v1.1 — fit-mode-aware scale (may raise ValueError on 1:1/custom overflow)
    scale, tx, ty = _compute_fit_scale(bbox, lay, fit_mode, custom_scale)

    def tx_pt(x, y):
        return (tx + x * scale, ty - y * scale)

    sorted_layers = sorted(layers, key=lambda L: int(L.get("order") or 0))
    is_assembly = drawing_type == "assembly_stack"

    for layer in sorted_layers:
        _render_layer_shapes(c, layer, tx_pt)

    for layer in sorted_layers:
        _render_layer_dimensions(c, layer, tx_pt)

    for layer in sorted_layers:
        _render_layer_callouts(c, layer, tx_pt)

    if is_assembly and len(sorted_layers) > 1:
        _render_layer_legend(c, lay, sorted_layers)


def _compute_bbox(layers):
    xs, ys = [], []
    for layer in layers:
        for sh in layer.get("shapes", []) or []:
            t = sh.get("type")
            if t == "circ":
                cx, cy, r = sh.get("cx", 0), sh.get("cy", 0), sh.get("r", 0)
                xs.extend([cx - r, cx + r])
                ys.extend([cy - r, cy + r])
            else:
                for p in sh.get("pts", []) or []:
                    xs.append(p.get("x", 0))
                    ys.append(p.get("y", 0))
        for d in layer.get("dimensions", []) or []:
            xs.extend([d.get("x1", 0), d.get("x2", 0)])
            ys.extend([d.get("y1", 0), d.get("y2", 0)])
        for ca in layer.get("callouts", []) or []:
            xs.extend([ca.get("tipX", 0), ca.get("tailX", 0)])
            ys.extend([ca.get("tipY", 0), ca.get("tailY", 0)])
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _render_layer_shapes(c, layer, tx_pt):
    layer_color = _hex(layer.get("color") or "#1A2F4A")
    fill_op    = layer.get("fillOpacity",   DEFAULT_FILL_OPACITY)
    stroke_op  = layer.get("strokeOpacity", DEFAULT_STROKE_OPACITY)
    sw         = layer.get("strokeWeight",  DEFAULT_STROKE_WEIGHT)
    fill_on    = layer.get("fillOn",   DEFAULT_FILL_ON)
    stroke_on  = layer.get("strokeOn", DEFAULT_STROKE_ON)

    for sh in layer.get("shapes", []) or []:
        s_fill_op   = sh.get("fillOpacity",   fill_op)
        s_stroke_op = sh.get("strokeOpacity", stroke_op)
        s_sw        = sh.get("strokeWeight",  sw)
        s_fill_on   = sh.get("fillOn",   fill_on)
        s_stroke_on = sh.get("strokeOn", stroke_on)

        c.setFillColor(_with_alpha(layer_color, s_fill_op))
        c.setStrokeColor(_with_alpha(layer_color, s_stroke_op))
        c.setLineWidth(float(s_sw or DEFAULT_STROKE_WEIGHT))

        do_fill   = 1 if s_fill_on   else 0
        do_stroke = 1 if s_stroke_on else 0

        t = sh.get("type")
        if t in ("poly", "tri", "rect"):
            pts = sh.get("pts") or []
            if len(pts) < 2:
                continue
            p = c.beginPath()
            x0, y0 = tx_pt(pts[0]["x"], pts[0]["y"])
            p.moveTo(x0, y0)
            for pt in pts[1:]:
                xx, yy = tx_pt(pt["x"], pt["y"])
                p.lineTo(xx, yy)
            p.close()
            c.drawPath(p, fill=do_fill, stroke=do_stroke)

        elif t == "line":
            pts = sh.get("pts") or []
            if len(pts) < 2:
                continue
            x1, y1 = tx_pt(pts[0]["x"], pts[0]["y"])
            x2, y2 = tx_pt(pts[1]["x"], pts[1]["y"])
            c.line(x1, y1, x2, y2)

        elif t == "circ":
            cx, cy = tx_pt(sh.get("cx", 0), sh.get("cy", 0))
            cx2, _ = tx_pt(sh.get("cx", 0) + sh.get("r", 0), sh.get("cy", 0))
            r_pt = abs(cx2 - cx)
            c.circle(cx, cy, r_pt, fill=do_fill, stroke=do_stroke)


def _render_layer_dimensions(c, layer, tx_pt):
    for d in layer.get("dimensions", []) or []:
        x1j, y1j = d.get("x1", 0), d.get("y1", 0)
        x2j, y2j = d.get("x2", 0), d.get("y2", 0)
        x1, y1 = tx_pt(x1j, y1j)
        x2, y2 = tx_pt(x2j, y2j)

        dx, dy = x2 - x1, y2 - y1
        L = (dx * dx + dy * dy) ** 0.5
        if L < 1e-6:
            continue
        ux, uy = dx / L, dy / L
        px, py = uy, -ux
        ox = px * DIM_EXTENSION_OFFSET
        oy = py * DIM_EXTENSION_OFFSET

        c.setStrokeColor(DIM_AMBER)
        c.setLineWidth(DIM_LINE_SW)
        c.line(x1, y1, x1 + ox, y1 + oy)
        c.line(x2, y2, x2 + ox, y2 + oy)

        ax1, ay1 = x1 + ox, y1 + oy
        ax2, ay2 = x2 + ox, y2 + oy
        c.line(ax1, ay1, ax2, ay2)

        _arrow(c, ax1, ay1, -ux, -uy)
        _arrow(c, ax2, ay2,  ux,  uy)

        label = str(d.get("value") or "").strip()
        if label:
            mx = (ax1 + ax2) / 2
            my = (ay1 + ay2) / 2
            lx = mx + px * (DIM_LABEL_PAD + DIM_LABEL_SIZE * 0.55)
            ly = my + py * (DIM_LABEL_PAD + DIM_LABEL_SIZE * 0.55) - DIM_LABEL_SIZE * 0.35
            c.setFont(DIM_LABEL_FONT, DIM_LABEL_SIZE)
            tw = c.stringWidth(label, DIM_LABEL_FONT, DIM_LABEL_SIZE)
            c.setFillColor(white)
            c.rect(lx - tw / 2 - DIM_LABEL_BG_PAD,
                   ly - DIM_LABEL_BG_PAD,
                   tw + 2 * DIM_LABEL_BG_PAD,
                   DIM_LABEL_SIZE + 2 * DIM_LABEL_BG_PAD,
                   fill=1, stroke=0)
            c.setFillColor(DIM_AMBER)
            c.drawCentredString(lx, ly, label)


def _arrow(c, x, y, ux, uy):
    bx = x - ux * DIM_ARROW_LEN
    by = y - uy * DIM_ARROW_LEN
    px, py = uy, -ux
    p1x = bx + px * DIM_ARROW_HALF_W
    p1y = by + py * DIM_ARROW_HALF_W
    p2x = bx - px * DIM_ARROW_HALF_W
    p2y = by - py * DIM_ARROW_HALF_W
    p = c.beginPath()
    p.moveTo(x, y)
    p.lineTo(p1x, p1y)
    p.lineTo(p2x, p2y)
    p.close()
    c.setFillColor(DIM_AMBER)
    c.drawPath(p, fill=1, stroke=0)


def _render_layer_callouts(c, layer, tx_pt):
    for ca in layer.get("callouts", []) or []:
        tipx, tipy   = tx_pt(ca.get("tipX", 0),  ca.get("tipY", 0))
        tailx, taily = tx_pt(ca.get("tailX", 0), ca.get("tailY", 0))
        num   = int(ca.get("num") or 0)
        text  = str(ca.get("textEN") or "").strip()

        c.setStrokeColor(CALLOUT_LEADER_COLOR)
        c.setLineWidth(CALLOUT_LEADER_SW)
        c.line(tipx, tipy, tailx, taily)

        if text:
            c.setFont(CALLOUT_TEXT_FONT, CALLOUT_TEXT_SIZE)
            tw = c.stringWidth(text, CALLOUT_TEXT_FONT, CALLOUT_TEXT_SIZE)
            box_w = tw + 2 * CALLOUT_BOX_PAD_X
            box_h = CALLOUT_TEXT_SIZE + 2 * CALLOUT_BOX_PAD_Y
            bx0 = tailx - box_w / 2
            by0 = taily - box_h / 2
            c.setFillColor(CALLOUT_BOX_FILL)
            c.setStrokeColor(CALLOUT_BOX_STROKE)
            c.setLineWidth(CALLOUT_BOX_SW)
            c.rect(bx0, by0, box_w, box_h, fill=1, stroke=1)
            c.setFillColor(CALLOUT_TEXT_COLOR)
            c.drawCentredString(tailx, by0 + CALLOUT_BOX_PAD_Y + CALLOUT_TEXT_SIZE * 0.2,
                                text)

        c.setFillColor(CALLOUT_TIP_FILL)
        c.setStrokeColor(CALLOUT_TIP_STROKE)
        c.setLineWidth(CALLOUT_TIP_STROKE_SW)
        c.circle(tipx, tipy, CALLOUT_TIP_R, fill=1, stroke=1)
        if num > 0:
            c.setFillColor(CALLOUT_NUM_COLOR)
            c.setFont(CALLOUT_NUM_FONT, CALLOUT_NUM_SIZE)
            c.drawCentredString(tipx, tipy - CALLOUT_NUM_SIZE * 0.32, str(num))


def _render_layer_legend(c, lay, sorted_layers):
    """Assembly-stack legend in lower-right of drawing area."""
    pad = 6
    line_h = LAYER_LABEL_SIZE + 4
    swatch = 8
    rows = list(reversed(sorted_layers))
    box_h = pad * 2 + line_h * len(rows)

    c.setFont(LAYER_LABEL_FONT, LAYER_LABEL_SIZE)
    widest = max(
        c.stringWidth(str(L.get("name") or "Layer"), LAYER_LABEL_FONT, LAYER_LABEL_SIZE)
        for L in rows
    )
    box_w = pad * 2 + swatch + 6 + widest

    bx1 = lay["draw_x1"] - DRAW_FIT_MARGIN
    by0 = lay["draw_y0"] + DRAW_FIT_MARGIN
    bx0 = bx1 - box_w
    by1 = by0 + box_h

    c.setFillColor(white)
    c.setStrokeColor(KCC_NAVY)
    c.setLineWidth(0.5)
    c.rect(bx0, by0, box_w, box_h, fill=1, stroke=1)

    for i, L in enumerate(rows):
        row_y = by1 - pad - (i + 1) * line_h + 4
        c.setFillColor(_hex(L.get("color") or "#1A2F4A"))
        c.setStrokeColor(KCC_NAVY)
        c.setLineWidth(0.3)
        c.rect(bx0 + pad, row_y, swatch, swatch, fill=1, stroke=1)
        c.setFillColor(KCC_NAVY)
        c.setFont(LAYER_LABEL_FONT, LAYER_LABEL_SIZE)
        c.drawString(bx0 + pad + swatch + 6, row_y + 1, str(L.get("name") or "Layer"))


# =============================================================================
# UTILITIES
# =============================================================================

def _slug(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"[^A-Za-z0-9_\-]", "", s)
    s = re.sub(r"-{2,}", "-", s).strip("-_")
    return s or "untitled"


def _format_spec_value(v) -> str:
    if v is None:
        return "—"
    s = str(v).strip()
    return s if s else "—"


def _ellipsize(c, text, font, size, max_w):
    if c.stringWidth(text, font, size) <= max_w:
        return text
    while text and c.stringWidth(text + "…", font, size) > max_w:
        text = text[:-1]
    return (text + "…") if text else "…"


def _hex(s) -> Color:
    if isinstance(s, Color):
        return s
    s = (s or "").strip()
    if not s:
        return KCC_NAVY
    if not s.startswith("#"):
        s = "#" + s
    try:
        return HexColor(s)
    except Exception:
        return KCC_NAVY


def _with_alpha(color: Color, alpha) -> Color:
    try:
        a = float(alpha) if alpha is not None else 1.0
    except (TypeError, ValueError):
        a = 1.0
    a = max(0.0, min(1.0, a))
    return Color(color.red, color.green, color.blue, alpha=a)


# =============================================================================
# CLI — render from a JSON file path (for manual / scripted invocation)
# =============================================================================

if __name__ == "__main__":
    import argparse
    import json
    import sys

    ap = argparse.ArgumentParser(
        description="Render a KCC RoofMark shop drawing PDF from a "
                    "RoofMark Technical Drawing JSON export. (v1.1)"
    )
    ap.add_argument("json_path", help="Path to roofmark-technical-*.json")
    ap.add_argument("--out-dir", default=".", help="Output directory")
    args = ap.parse_args()

    with open(args.json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    out = render_shop_drawing(data, args.out_dir)
    print(out)
