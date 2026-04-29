"""
================================================================================
kcc-shop-drawing.py — KCC RoofMark Locked Shop Drawing Template
================================================================================

Status      : LOCKED — v1.0 — April 28 2026
Authority   : Approved title block layout draft v3 (Webster Groves session)
Spec        : RoofMark Kickoff Spec v1.0, Section 21 — Technical Drawing Mode
              https://www.notion.so/33eca70abea681668644c1dc03228839
Branding    : KCC Operational Standards — navy / orange / Arial-equivalent
              https://www.notion.so/33dca70abea681c48ce8ff448587bfe4

Purpose
-------
Single-pass shop drawing PDF producer. A Claude thread reads a RoofMark
Technical Drawing JSON export, calls render_shop_drawing(data, out_dir),
and gets back a finished, fabricator-ready PDF. No layout iteration. No
template variables. Every position, font size, color, and proportion is a
hardcoded constant in this file.

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
            "shapes":     [ shape, ... ],      # see shape spec below
            "dimensions": [ dim, ... ],        # see dimension spec below
            "callouts":   [ callout, ... ],    # see callout spec below
        },
        ...
    ],
    "drawingType":   "profile" | "assembly_stack",
    "internalScale": 24,                       # px per inch — fixed, never changes
}

Shape object
------------
Same as RoofMark canvas shape:
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
(Spanish text is not rendered on the shop drawing — fabricators read the
fabrication-shop language only. textES is ignored here.)

Output
------
PDF written to:  out_dir / [drawingNo]_[partName-slug].pdf
Filename slug rule: partName has spaces -> hyphens, all non-alphanumeric/
underscore/hyphen characters dropped, double hyphens collapsed.
Returns the absolute path of the produced PDF as a string.

Page format
-----------
Letter landscape (11.0in x 8.5in = 792pt x 612pt). Origin at bottom-left.

================================================================================
"""

from __future__ import annotations
import os
import re
from pathlib import Path

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.colors import HexColor, white, black, Color


# =============================================================================
# LOCKED LAYOUT CONSTANTS — DO NOT EDIT WITHOUT A NEW DESIGN SESSION
# =============================================================================

# ---- Page ------------------------------------------------------------------
PAGE_W = 792.0     # 11.0 in
PAGE_H = 612.0     # 8.5 in

# ---- Brand colors ----------------------------------------------------------
KCC_NAVY        = HexColor("#1A2F4A")
KCC_ORANGE      = HexColor("#E8630A")
LIGHT_GRAY_BG   = HexColor("#ECEEF2")
GRID_LIGHT      = HexColor("#C8D8E8")
SPEC_TABLE_BG   = HexColor("#F5F6F8")
TEXT_DIM        = HexColor("#666666")
HEADER_SUB_TEXT = HexColor("#C8D8E8")
DIM_AMBER       = HexColor("#B8860B")   # dimension labels (print-friendly amber)

# ---- Sheet frame -----------------------------------------------------------
MARGIN          = 25.2     # 0.35 in — perimeter inset

SHEET_X0        = MARGIN
SHEET_Y0        = MARGIN
SHEET_X1        = PAGE_W - MARGIN
SHEET_Y1        = PAGE_H - MARGIN

SHEET_BORDER_SW = 1.0      # navy perimeter line weight

# ---- Header bar ------------------------------------------------------------
HEADER_H        = 39.6     # 0.55 in
HDR_LEFT_PAD    = 14.4     # 0.20 in
HDR_RIGHT_PAD   = 14.4     # 0.20 in

HDR_Y1          = SHEET_Y1
HDR_Y0          = HDR_Y1 - HEADER_H

# Header LEFT — primary line (company)
HDR_L_PRIMARY_Y       = HDR_Y0 + HEADER_H * 0.58   # baseline
HDR_L_PRIMARY_FONT    = "Helvetica-Bold"
HDR_L_PRIMARY_SIZE    = 13
HDR_L_PRIMARY_COLOR   = white
HDR_L_PRIMARY_TEXT    = "KOSAREK CONSTRUCTION CO."

# Header LEFT — secondary line (license / tagline)
HDR_L_SECONDARY_Y     = HDR_Y0 + HEADER_H * 0.20
HDR_L_SECONDARY_FONT  = "Helvetica"
HDR_L_SECONDARY_SIZE  = 7.5
HDR_L_SECONDARY_COLOR = HEADER_SUB_TEXT
HDR_L_SECONDARY_TEXT  = "Illinois Unlimited Roofing License  |  Engineered Roofing Precision"

# Header RIGHT — small label "SHOP DRAWING" (orange)
HDR_R_LABEL_Y         = HDR_Y0 + HEADER_H * 0.62
HDR_R_LABEL_FONT      = "Helvetica-Bold"
HDR_R_LABEL_SIZE      = 8
HDR_R_LABEL_COLOR     = KCC_ORANGE
HDR_R_LABEL_TEXT      = "SHOP DRAWING"

# Header RIGHT — primary identifier (drawing number, white, large)
HDR_R_DWGNO_Y         = HDR_Y0 + HEADER_H * 0.18
HDR_R_DWGNO_FONT      = "Helvetica-Bold"
HDR_R_DWGNO_SIZE      = 15
HDR_R_DWGNO_COLOR     = white

# ---- Orange accent stripe --------------------------------------------------
ACCENT_H        = 4.3      # 0.06 in
ACC_Y1          = HDR_Y0
ACC_Y0          = ACC_Y1 - ACCENT_H

# ---- Footer bar ------------------------------------------------------------
FOOTER_H        = 21.6     # 0.30 in
FTR_Y0          = SHEET_Y0
FTR_Y1          = FTR_Y0 + FOOTER_H

FTR_TEXT_Y      = FTR_Y0 + FOOTER_H * 0.32
FTR_LEFT_FONT   = "Helvetica-Bold"
FTR_LEFT_SIZE   = 7
FTR_LEFT_COLOR  = white
FTR_LEFT_TEXT   = "KCC ROOFMARK  |  AEROSPACE-GRADE PROCESS DISCIPLINE FOR ROOFING"

FTR_RIGHT_FONT  = "Helvetica"
FTR_RIGHT_SIZE  = 7
FTR_RIGHT_COLOR = HEADER_SUB_TEXT
FTR_RIGHT_TEXT  = "kcc-shop-drawing.py v1.0  |  internal scale 24 px / inch"

# ---- Spec table ------------------------------------------------------------
SPEC_TABLE_H    = 75.6     # 1.05 in
SPEC_Y0         = FTR_Y1
SPEC_Y1         = SPEC_Y0 + SPEC_TABLE_H

# Top stripe of spec table (navy bar with section title)
ST_BAR_H        = 12.96    # 0.18 in
ST_BAR_Y0       = SPEC_Y1 - ST_BAR_H
ST_BAR_Y1       = SPEC_Y1

ST_BAR_TEXT_Y   = ST_BAR_Y0 + ST_BAR_H * 0.30
ST_BAR_L_FONT   = "Helvetica-Bold"
ST_BAR_L_SIZE   = 8
ST_BAR_L_COLOR  = white
ST_BAR_L_TEXT   = "PART  &  JOB  SPECIFICATION"

ST_BAR_R_FONT   = "Helvetica-Oblique"
ST_BAR_R_SIZE   = 7
ST_BAR_R_COLOR  = HEADER_SUB_TEXT
ST_BAR_R_TEXT   = "KCC RoofMark — Locked Title Block"

# Spec field grid: 4 columns x 2 rows = 8 fields
SPEC_COLS       = 4
SPEC_ROWS       = 2
SPEC_GRID_Y0    = SPEC_Y0
SPEC_GRID_Y1    = ST_BAR_Y0
SPEC_COL_W      = (SHEET_X1 - SHEET_X0) / SPEC_COLS
SPEC_ROW_H      = (SPEC_GRID_Y1 - SPEC_GRID_Y0) / SPEC_ROWS

SPEC_DIVIDER_SW = 0.4

# Field order, row-major (top row left-to-right, then bottom row left-to-right)
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

# ---- Drawing area ----------------------------------------------------------
DRAW_TOP_PAD    = 7.2      # 0.10 in
DRAW_BOT_PAD    = 7.2      # 0.10 in
DRAW_SIDE_PAD   = 7.2

DRAW_X0         = SHEET_X0 + DRAW_SIDE_PAD
DRAW_X1         = SHEET_X1 - DRAW_SIDE_PAD
DRAW_Y0         = SPEC_Y1 + DRAW_BOT_PAD
DRAW_Y1         = ACC_Y0  - DRAW_TOP_PAD

DRAW_BORDER_SW  = 0.5
DRAW_GRID_SPACING = 36.0   # 0.5 in faint grid lines
DRAW_GRID_SW    = 0.25

# Corner crosshairs (orange) on drawing area
CROSSHAIR_LEN   = 10
CROSSHAIR_SW    = 1.0

# Auto-fit scaling — geometry from JSON is in pixels at 24 px/in.
# Scale factor is computed at render time so the drawing fills the area
# while preserving aspect ratio. Margin inside the drawing area:
DRAW_FIT_MARGIN = 18.0     # pt — reserves space for dimension lines and labels

# ---- Geometry rendering ----------------------------------------------------
DEFAULT_FILL_OPACITY    = 0.25
DEFAULT_STROKE_OPACITY  = 1.0
DEFAULT_STROKE_WEIGHT   = 1.6
DEFAULT_FILL_ON         = True
DEFAULT_STROKE_ON       = True

# Dimension line styling (matches RoofMark amber but print-friendly)
DIM_EXTENSION_OFFSET    = 14.0   # pt offset of extension line from endpoint
DIM_LINE_SW             = 0.8
DIM_ARROW_LEN           = 6.0
DIM_ARROW_HALF_W        = 2.5
DIM_LABEL_FONT          = "Helvetica-Bold"
DIM_LABEL_SIZE          = 8
DIM_LABEL_PAD           = 3.0
DIM_LABEL_BG_PAD        = 2.0

# Callout styling (numbered tip + text bubble)
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

# Layer label (component name printed near the layer in assembly stack mode)
LAYER_LABEL_FONT        = "Helvetica-Bold"
LAYER_LABEL_SIZE        = 7.5


# =============================================================================
# RENDER FUNCTION (the one entry point)
# =============================================================================

def render_shop_drawing(data: dict, out_dir: str | os.PathLike = ".") -> str:
    """Produce the locked KCC shop drawing PDF from a RoofMark Technical
    Drawing export dict.

    Returns the absolute path to the written PDF.
    """
    spec = data.get("specTable") or {}
    layers = data.get("layers") or []
    drawing_type = (data.get("drawingType") or "profile").lower()
    internal_scale = float(data.get("internalScale") or 24.0)  # px per inch — kept for future use

    # ---- validate required spec fields --------------------------------------
    for required in ("partName", "material", "drawingNo"):
        if not str(spec.get(required) or "").strip():
            raise ValueError(
                f"specTable.{required} is required and was empty. "
                f"Got specTable={spec!r}"
            )

    drawing_no = str(spec["drawingNo"]).strip()
    part_name  = str(spec["partName"]).strip()

    # ---- compute output filename --------------------------------------------
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{_slug(drawing_no)}_{_slug(part_name)}.pdf"
    out_path = (out_dir / fname).resolve()

    # ---- canvas -------------------------------------------------------------
    c = canvas.Canvas(str(out_path), pagesize=landscape(letter))
    c.setTitle(f"KCC Shop Drawing {drawing_no} — {part_name}")
    c.setAuthor("Kosarek Construction Company")
    c.setSubject(f"Drawing type: {drawing_type}")
    c.setCreator("kcc-shop-drawing.py v1.0")

    _draw_page_background(c)
    _draw_sheet_border(c)
    _draw_header(c, drawing_no)
    _draw_accent_stripe(c)
    _draw_footer(c)
    _draw_spec_table(c, spec)
    _draw_drawing_area_frame(c)
    _draw_geometry(c, layers, drawing_type)

    c.save()
    return str(out_path)


# =============================================================================
# DRAW HELPERS — title block (locked layout)
# =============================================================================

def _draw_page_background(c):
    c.setFillColor(LIGHT_GRAY_BG)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)


def _draw_sheet_border(c):
    c.setStrokeColor(KCC_NAVY)
    c.setLineWidth(SHEET_BORDER_SW)
    c.rect(SHEET_X0, SHEET_Y0,
           SHEET_X1 - SHEET_X0, SHEET_Y1 - SHEET_Y0, fill=0, stroke=1)


def _draw_header(c, drawing_no: str):
    # Navy header bar
    c.setFillColor(KCC_NAVY)
    c.rect(SHEET_X0, HDR_Y0, SHEET_X1 - SHEET_X0, HEADER_H, fill=1, stroke=0)

    # LEFT — primary
    c.setFillColor(HDR_L_PRIMARY_COLOR)
    c.setFont(HDR_L_PRIMARY_FONT, HDR_L_PRIMARY_SIZE)
    c.drawString(SHEET_X0 + HDR_LEFT_PAD, HDR_L_PRIMARY_Y, HDR_L_PRIMARY_TEXT)

    # LEFT — secondary
    c.setFillColor(HDR_L_SECONDARY_COLOR)
    c.setFont(HDR_L_SECONDARY_FONT, HDR_L_SECONDARY_SIZE)
    c.drawString(SHEET_X0 + HDR_LEFT_PAD, HDR_L_SECONDARY_Y, HDR_L_SECONDARY_TEXT)

    # RIGHT — small label "SHOP DRAWING" (orange)
    c.setFillColor(HDR_R_LABEL_COLOR)
    c.setFont(HDR_R_LABEL_FONT, HDR_R_LABEL_SIZE)
    c.drawRightString(SHEET_X1 - HDR_RIGHT_PAD, HDR_R_LABEL_Y, HDR_R_LABEL_TEXT)

    # RIGHT — primary identifier (drawing number, white, large)
    c.setFillColor(HDR_R_DWGNO_COLOR)
    c.setFont(HDR_R_DWGNO_FONT, HDR_R_DWGNO_SIZE)
    c.drawRightString(SHEET_X1 - HDR_RIGHT_PAD, HDR_R_DWGNO_Y, drawing_no)


def _draw_accent_stripe(c):
    c.setFillColor(KCC_ORANGE)
    c.rect(SHEET_X0, ACC_Y0, SHEET_X1 - SHEET_X0, ACCENT_H, fill=1, stroke=0)


def _draw_footer(c):
    c.setFillColor(KCC_NAVY)
    c.rect(SHEET_X0, FTR_Y0, SHEET_X1 - SHEET_X0, FOOTER_H, fill=1, stroke=0)

    c.setFillColor(FTR_LEFT_COLOR)
    c.setFont(FTR_LEFT_FONT, FTR_LEFT_SIZE)
    c.drawString(SHEET_X0 + HDR_LEFT_PAD, FTR_TEXT_Y, FTR_LEFT_TEXT)

    c.setFillColor(FTR_RIGHT_COLOR)
    c.setFont(FTR_RIGHT_FONT, FTR_RIGHT_SIZE)
    c.drawRightString(SHEET_X1 - HDR_RIGHT_PAD, FTR_TEXT_Y, FTR_RIGHT_TEXT)


def _draw_spec_table(c, spec: dict):
    # Body fill
    c.setFillColor(SPEC_TABLE_BG)
    c.setStrokeColor(KCC_NAVY)
    c.setLineWidth(0.75)
    c.rect(SHEET_X0, SPEC_Y0,
           SHEET_X1 - SHEET_X0, SPEC_TABLE_H, fill=1, stroke=1)

    # Top stripe
    c.setFillColor(KCC_NAVY)
    c.rect(SHEET_X0, ST_BAR_Y0, SHEET_X1 - SHEET_X0, ST_BAR_H, fill=1, stroke=0)

    c.setFillColor(ST_BAR_L_COLOR)
    c.setFont(ST_BAR_L_FONT, ST_BAR_L_SIZE)
    c.drawString(SHEET_X0 + HDR_LEFT_PAD, ST_BAR_TEXT_Y, ST_BAR_L_TEXT)

    c.setFillColor(ST_BAR_R_COLOR)
    c.setFont(ST_BAR_R_FONT, ST_BAR_R_SIZE)
    c.drawRightString(SHEET_X1 - HDR_RIGHT_PAD, ST_BAR_TEXT_Y, ST_BAR_R_TEXT)

    # Grid dividers
    c.setStrokeColor(KCC_NAVY)
    c.setLineWidth(SPEC_DIVIDER_SW)
    for i in range(1, SPEC_COLS):
        xv = SHEET_X0 + i * SPEC_COL_W
        c.line(xv, SPEC_GRID_Y0, xv, SPEC_GRID_Y1)
    yh = SPEC_GRID_Y0 + SPEC_ROW_H
    c.line(SHEET_X0, yh, SHEET_X1, yh)

    # Field labels + values
    for idx, (label, key) in enumerate(SPEC_FIELDS):
        row = idx // SPEC_COLS
        col = idx %  SPEC_COLS
        cell_x0 = SHEET_X0 + col * SPEC_COL_W
        cell_y1 = SPEC_GRID_Y1 - row * SPEC_ROW_H
        cell_y0 = cell_y1 - SPEC_ROW_H

        # Label (orange, bold, top of cell)
        c.setFillColor(SPEC_LABEL_COLOR)
        c.setFont(SPEC_LABEL_FONT, SPEC_LABEL_SIZE)
        c.drawString(cell_x0 + SPEC_LABEL_PAD_X,
                     cell_y1 - SPEC_LABEL_OFFSET_Y,
                     label)

        # Value (navy, body weight, bottom of cell)
        value_text = _format_spec_value(spec.get(key))
        # truncate to fit cell width
        max_w = SPEC_COL_W - 2 * SPEC_VALUE_PAD_X
        value_text = _ellipsize(c, value_text, SPEC_VALUE_FONT, SPEC_VALUE_SIZE, max_w)

        c.setFillColor(SPEC_VALUE_COLOR)
        c.setFont(SPEC_VALUE_FONT, SPEC_VALUE_SIZE)
        c.drawString(cell_x0 + SPEC_VALUE_PAD_X,
                     cell_y0 + SPEC_VALUE_OFFSET_Y,
                     value_text)


def _draw_drawing_area_frame(c):
    # White interior + faint border
    c.setFillColor(white)
    c.setStrokeColor(GRID_LIGHT)
    c.setLineWidth(DRAW_BORDER_SW)
    c.rect(DRAW_X0, DRAW_Y0,
           DRAW_X1 - DRAW_X0, DRAW_Y1 - DRAW_Y0, fill=1, stroke=1)

    # Faint blueprint grid
    c.setStrokeColor(GRID_LIGHT)
    c.setLineWidth(DRAW_GRID_SW)
    x = DRAW_X0
    while x < DRAW_X1:
        c.line(x, DRAW_Y0, x, DRAW_Y1)
        x += DRAW_GRID_SPACING
    y = DRAW_Y0
    while y < DRAW_Y1:
        c.line(DRAW_X0, y, DRAW_X1, y)
        y += DRAW_GRID_SPACING

    # Orange corner crosshairs
    c.setStrokeColor(KCC_ORANGE)
    c.setLineWidth(CROSSHAIR_SW)
    for (cx, cy) in ((DRAW_X0, DRAW_Y0), (DRAW_X1, DRAW_Y0),
                     (DRAW_X0, DRAW_Y1), (DRAW_X1, DRAW_Y1)):
        c.line(cx - CROSSHAIR_LEN, cy, cx + CROSSHAIR_LEN, cy)
        c.line(cx, cy - CROSSHAIR_LEN, cx, cy + CROSSHAIR_LEN)


# =============================================================================
# DRAW HELPERS — geometry (auto-fit + render layers/dimensions/callouts)
# =============================================================================

def _draw_geometry(c, layers: list, drawing_type: str):
    """Auto-fit all layer shapes / dimensions / callouts into the drawing area
    while preserving aspect ratio, then render bottom-to-top by layer.order."""
    if not layers:
        # No geometry — draw a small note in the center
        c.setFillColor(TEXT_DIM)
        c.setFont("Helvetica-Oblique", 9)
        c.drawCentredString((DRAW_X0 + DRAW_X1) / 2,
                            (DRAW_Y0 + DRAW_Y1) / 2,
                            "(no geometry in JSON)")
        return

    # 1. Compute bounding box of every drawable point in JSON-space (px)
    bbox = _compute_bbox(layers)
    if bbox is None:
        return
    bx0, by0, bx1, by1 = bbox
    bw = max(bx1 - bx0, 1e-6)
    bh = max(by1 - by0, 1e-6)

    # 2. Compute fit transform (JSON px -> PDF pt inside drawing area)
    fit_x0 = DRAW_X0 + DRAW_FIT_MARGIN
    fit_y0 = DRAW_Y0 + DRAW_FIT_MARGIN
    fit_x1 = DRAW_X1 - DRAW_FIT_MARGIN
    fit_y1 = DRAW_Y1 - DRAW_FIT_MARGIN
    fw = fit_x1 - fit_x0
    fh = fit_y1 - fit_y0

    scale = min(fw / bw, fh / bh)

    # Center the drawing within the fit area
    tx = fit_x0 + (fw - bw * scale) / 2 - bx0 * scale
    # JSON-space y grows downward (canvas convention). PDF y grows upward.
    # Flip y so the top of the drawing in RoofMark appears at the top in PDF.
    ty = fit_y1 - (fh - bh * scale) / 2 + by0 * scale

    def tx_pt(x, y):
        return (tx + x * scale, ty - y * scale)

    # 3. Sort layers by order (bottom to top) and render
    sorted_layers = sorted(layers, key=lambda L: int(L.get("order") or 0))

    is_assembly = drawing_type == "assembly_stack"

    for layer in sorted_layers:
        _render_layer_shapes(c, layer, tx_pt)

    # Dimensions and callouts render on top of all shapes
    for layer in sorted_layers:
        _render_layer_dimensions(c, layer, tx_pt)

    for layer in sorted_layers:
        _render_layer_callouts(c, layer, tx_pt)

    # 4. Layer legend for assembly_stack (component name labels in lower-right)
    if is_assembly and len(sorted_layers) > 1:
        _render_layer_legend(c, sorted_layers)


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
        # Per-shape overrides fall back to layer values
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
            # Scale radius using the same factor used in tx_pt. Recover scale
            # from any two points of a known-distance shape would be overkill;
            # the bbox is built using r directly so we pull scale from the
            # ratio of any drawn x-coordinate. Simpler: re-derive scale here.
            # For this single render, scale is consistent across x and y, so:
            cx2, _ = tx_pt(sh.get("cx", 0) + sh.get("r", 0), sh.get("cy", 0))
            r_pt = abs(cx2 - cx)
            c.circle(cx, cy, r_pt, fill=do_fill, stroke=do_stroke)


def _render_layer_dimensions(c, layer, tx_pt):
    for d in layer.get("dimensions", []) or []:
        x1j, y1j = d.get("x1", 0), d.get("y1", 0)
        x2j, y2j = d.get("x2", 0), d.get("y2", 0)
        x1, y1 = tx_pt(x1j, y1j)
        x2, y2 = tx_pt(x2j, y2j)

        # Compute perpendicular offset direction (always offset "up" in JSON
        # space, which is "down" in PDF after y-flip — visually above the line
        # of the dimension's natural orientation).
        dx, dy = x2 - x1, y2 - y1
        L = (dx * dx + dy * dy) ** 0.5
        if L < 1e-6:
            continue
        ux, uy = dx / L, dy / L
        # Perpendicular (right-hand): rotate (ux, uy) by -90° in PDF coords
        px, py = uy, -ux
        ox = px * DIM_EXTENSION_OFFSET
        oy = py * DIM_EXTENSION_OFFSET

        # Extension lines from each endpoint to the offset point
        c.setStrokeColor(DIM_AMBER)
        c.setLineWidth(DIM_LINE_SW)
        c.line(x1, y1, x1 + ox, y1 + oy)
        c.line(x2, y2, x2 + ox, y2 + oy)

        # Dimension line between offset endpoints
        ax1, ay1 = x1 + ox, y1 + oy
        ax2, ay2 = x2 + ox, y2 + oy
        c.line(ax1, ay1, ax2, ay2)

        # Arrowheads at each end (pointing outward toward extension lines)
        _arrow(c, ax1, ay1, -ux, -uy)
        _arrow(c, ax2, ay2,  ux,  uy)

        # Label
        label = str(d.get("value") or "").strip()
        if label:
            mx = (ax1 + ax2) / 2
            my = (ay1 + ay2) / 2
            # Offset label slightly perpendicular to dim line
            lx = mx + px * (DIM_LABEL_PAD + DIM_LABEL_SIZE * 0.55)
            ly = my + py * (DIM_LABEL_PAD + DIM_LABEL_SIZE * 0.55) - DIM_LABEL_SIZE * 0.35
            # White background pad behind label for legibility
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
    """Filled triangular arrowhead at (x,y) pointing in direction (ux,uy)."""
    # Tip is at (x,y); base is back along -direction by DIM_ARROW_LEN.
    bx = x - ux * DIM_ARROW_LEN
    by = y - uy * DIM_ARROW_LEN
    # Perpendicular for base width
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

        # Leader line
        c.setStrokeColor(CALLOUT_LEADER_COLOR)
        c.setLineWidth(CALLOUT_LEADER_SW)
        c.line(tipx, tipy, tailx, taily)

        # Text bubble at tail
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

        # Numbered tip on top of leader
        c.setFillColor(CALLOUT_TIP_FILL)
        c.setStrokeColor(CALLOUT_TIP_STROKE)
        c.setLineWidth(CALLOUT_TIP_STROKE_SW)
        c.circle(tipx, tipy, CALLOUT_TIP_R, fill=1, stroke=1)
        if num > 0:
            c.setFillColor(CALLOUT_NUM_COLOR)
            c.setFont(CALLOUT_NUM_FONT, CALLOUT_NUM_SIZE)
            c.drawCentredString(tipx, tipy - CALLOUT_NUM_SIZE * 0.32, str(num))


def _render_layer_legend(c, sorted_layers):
    """For assembly_stack drawings: small legend in the lower-right of the
    drawing area listing each component in installation order."""
    pad = 6
    line_h = LAYER_LABEL_SIZE + 4
    swatch = 8
    rows = list(reversed(sorted_layers))   # top of legend = top of stack
    box_h = pad * 2 + line_h * len(rows)

    # measure widest
    c.setFont(LAYER_LABEL_FONT, LAYER_LABEL_SIZE)
    widest = max(
        c.stringWidth(str(L.get("name") or "Layer"), LAYER_LABEL_FONT, LAYER_LABEL_SIZE)
        for L in rows
    )
    box_w = pad * 2 + swatch + 6 + widest

    bx1 = DRAW_X1 - DRAW_FIT_MARGIN
    by0 = DRAW_Y0 + DRAW_FIT_MARGIN
    bx0 = bx1 - box_w
    by1 = by0 + box_h

    c.setFillColor(white)
    c.setStrokeColor(KCC_NAVY)
    c.setLineWidth(0.5)
    c.rect(bx0, by0, box_w, box_h, fill=1, stroke=1)

    for i, L in enumerate(rows):
        row_y = by1 - pad - (i + 1) * line_h + 4
        # color swatch
        c.setFillColor(_hex(L.get("color") or "#1A2F4A"))
        c.setStrokeColor(KCC_NAVY)
        c.setLineWidth(0.3)
        c.rect(bx0 + pad, row_y, swatch, swatch, fill=1, stroke=1)
        # name
        c.setFillColor(KCC_NAVY)
        c.setFont(LAYER_LABEL_FONT, LAYER_LABEL_SIZE)
        c.drawString(bx0 + pad + swatch + 6, row_y + 1, str(L.get("name") or "Layer"))


# =============================================================================
# UTILITIES
# =============================================================================

def _slug(s: str) -> str:
    """Filename-safe slug: spaces -> hyphens, drop non-[A-Za-z0-9_-], collapse."""
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
    # Trim from the right and add an ellipsis
    while text and c.stringWidth(text + "…", font, size) > max_w:
        text = text[:-1]
    return (text + "…") if text else "…"


def _hex(s: str) -> Color:
    """Parse a hex color string defensively."""
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
    """Return a new Color with the requested alpha."""
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
                    "RoofMark Technical Drawing JSON export."
    )
    ap.add_argument("json_path", help="Path to roofmark-technical-*.json")
    ap.add_argument("--out-dir", default=".", help="Output directory")
    args = ap.parse_args()

    with open(args.json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    out = render_shop_drawing(data, args.out_dir)
    print(out)
