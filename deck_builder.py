#!/usr/bin/env python3
"""
deck_builder.py — Atscale Revenue Audit deck generation.

Fills a fixed PPTX template's "Diagnosis Synthesis" slides (one per building
block) with assessment dots positioned from a self-assessment Excel export.

The dot geometry/styling is lifted verbatim from the proven standalone
`place_diagnosis_dots.py`; the only change is the score source — the Excel
`Dashboard` sheet instead of a hand-made CSV — and a bytes-in/bytes-out
`build_deck()` so the web server can call it on an uploaded file.
"""

import io
import re
from collections import defaultdict
from lxml import etree
from pptx import Presentation
from pptx.util import Pt
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.dml.color import RGBColor

# ── Axis constants (exact EMU match to the template) ─────────────────────────
AXIS_LEFT    = 4.189
COLUMN_WIDTH = 0.240

# ── Key Takeaways / Initiatives columns (right half of diagnosis synthesis slides)
# Two columns already headed in the template: "Key takeaways" + "Initiatives recommended"
TK_KT_LEFT    = 5.40   # Key takeaways column left edge
TK_KT_WIDTH   = 2.20
TK_INIT_LEFT  = 7.65   # Initiatives recommended column left edge
TK_INIT_WIDTH = 2.20
TK_ROW_TOP    = 1.70   # first row, below the column headers (headers end ~1.5")
TK_ROW_BOTTOM = 5.40   # bottom of the content area
TK_HIGHLIGHT_BORDER = "C0392B"   # dark red border for highlighted items
DOT_EMU      = 108000
DOT_WIDTH    = DOT_EMU / 914400
DOT_OFFSET   = (COLUMN_WIDTH - DOT_WIDTH) / 2

CLIENT_COLOR  = "DDC7C7"   # pink = self-assessment
ATSCALE_COLOR = "BDD3F3"   # blue = Atscale assessment

A_NS = '{http://schemas.openxmlformats.org/drawingml/2006/main}'

# Building blocks, in slide order. Slide numbers are 1-based positions in the
# template; the Excel `Dashboard` lists topics under these exact section names.
SLIDE_BB_MAP = {
    9:  "Sales Hiring & Ramp-Up",
    10: "Sales Enablement",
    11: "Sales Performance Management",
    12: "Talent Management",
    13: "Demand Generation",
    14: "Sales Execution",
    15: "Client Relationship",
    16: "Revenue Operations",
}
BB_NAMES = set(SLIDE_BB_MAP.values())

SLIDE_Y_CENTERS = {
    9:  [1.7828, 1.9526, 2.2542, 2.4103, 2.5801, 2.7362, 2.9060, 3.0621,
         3.2318, 3.3880, 3.6578, 3.8139, 3.9836, 4.2502, 4.4064, 4.5761,
         4.7322, 4.9020, 5.0673, 5.2355],
    10: [1.7682, 1.9232, 2.0780, 2.2268, 2.3745, 2.5306, 2.7444, 2.8785,
         3.0115, 3.1457, 3.3861, 3.5202, 3.6605, 3.8002, 4.0042, 4.1549,
         4.3016, 4.4504, 4.6055, 4.7616, 4.9167, 5.0747, 5.2429],
    11: [1.7828, 1.9526, 2.1186, 2.2748, 2.4445, 2.5967, 2.7664, 3.0254,
         3.1878, 3.3439, 3.5109, 3.6744, 3.8221, 4.1143, 4.2815, 4.4586,
         4.6441, 4.8212, 5.0012, 5.1841],
    12: [1.7682, 1.9232, 2.0780, 2.2268, 2.4773, 2.6481, 2.8252, 3.1282,
         3.3126, 3.4908, 3.6651, 3.8286, 3.9836, 4.1380, 4.3066, 4.6055,
         4.7616, 4.9167, 5.0747, 5.2429],
    13: [1.7828, 1.9526, 2.1186, 2.2748, 2.5479, 2.6995, 2.8546, 3.0107,
         3.2318, 3.3880, 3.5476, 3.7038, 3.9836, 4.1401, 4.2962, 4.4513,
         4.7322, 4.9020, 5.0673, 5.2355],
    14: [1.7828, 1.9526, 2.1186, 2.2748, 2.5479, 2.6995, 2.8546, 3.0107,
         3.2318, 3.3880, 3.5476, 3.7038, 3.9836, 4.1401, 4.2962, 4.4513,
         4.7322, 4.9020, 5.0673, 5.2355],
    15: [1.7828, 1.9526, 2.1186, 2.2748, 2.4445, 2.6995, 2.8693, 3.0254,
         3.1878, 3.4688, 3.6357, 3.7992, 3.9469, 4.1143, 4.2815, 4.4586,
         4.6441, 4.8212, 5.0012, 5.1841],
    16: [1.7828, 1.9526, 2.1186, 2.2748, 2.4445, 2.5967, 2.7664, 3.0254,
         3.1878, 3.3439, 3.5109, 3.6744, 3.8221, 3.9968, 4.1714, 4.4586,
         4.6441, 4.8212, 5.0012, 5.1841],
}


def to_emu(inches): return int(inches * 914400)
def score_to_x(score): return AXIS_LEFT + (score - 1) * COLUMN_WIDTH + DOT_OFFSET


def _is_number(v):
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def parse_self_assessment(xlsx_file):
    """Read the `Dashboard` sheet → (topics_by_bb, bb_avgs).

    `xlsx_file` is a path or a binary file-like. Topics are kept in sheet order
    (which matches the template's row order). A row is a topic when a building
    block is in scope and columns B/C/D hold (topic text, rating, atscale).
    """
    import openpyxl
    wb = openpyxl.load_workbook(xlsx_file, data_only=True)
    ws = wb["Dashboard"]

    topics_by_bb = defaultdict(list)
    cur_bb = None
    for r in range(1, ws.max_row + 1):
        a = str(ws.cell(r, 1).value or '').strip()
        b = ws.cell(r, 2).value
        c = ws.cell(r, 3).value
        d = ws.cell(r, 4).value
        if a in BB_NAMES:
            cur_bb = a
            continue
        if isinstance(b, str) and b.strip() == 'Topic':
            continue                          # sub-block header row
        if cur_bb and isinstance(b, str) and b.strip() and _is_number(c) and _is_number(d):
            topics_by_bb[cur_bb].append(
                {'topic': b.strip(), 'rating': float(c), 'atscale': float(d)})

    bb_avgs = {}
    for bb, rows in topics_by_bb.items():
        rv = [x['rating'] for x in rows]
        av = [x['atscale'] for x in rows]
        bb_avgs[bb] = {'client_avg': round(sum(rv) / len(rv), 1),
                       'atscale_avg': round(sum(av) / len(av), 1)}
    return topics_by_bb, bb_avgs


def is_placeholder_dot(shape):
    """True for a dot sitting on the assessment axis (template or already placed)."""
    tol = 20000
    if abs(shape.width - DOT_EMU) < tol and abs(shape.height - DOT_EMU) < tol:
        if 4.0 < shape.left / 914400 < 5.5:
            return True
    return False


def add_dot(slide, x_in, y_in, hex_color):
    """Insert an ellipse dot matching the template exactly (border, shadow, size)."""
    L, T, S = to_emu(x_in), to_emu(y_in), DOT_EMU
    xml_str = f'''\
<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:nvSpPr>
    <p:cNvPr id="9001" name="dot_placed"/>
    <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="{L}" y="{T}"/><a:ext cx="{S}" cy="{S}"/></a:xfrm>
    <a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>
    <a:solidFill><a:srgbClr val="{hex_color}"/></a:solidFill>
    <a:ln cap="flat" cmpd="sng" w="9525">
      <a:solidFill><a:schemeClr val="lt1"/></a:solidFill>
      <a:prstDash val="solid"/>
      <a:round/>
      <a:headEnd len="sm" w="sm" type="none"/>
      <a:tailEnd len="sm" w="sm" type="none"/>
    </a:ln>
    <a:effectLst>
      <a:outerShdw blurRad="57150" rotWithShape="0" algn="bl">
        <a:srgbClr val="000000"><a:alpha val="10000"/></a:srgbClr>
      </a:outerShdw>
    </a:effectLst>
  </p:spPr>
  <p:txBody>
    <a:bodyPr anchorCtr="0" anchor="ctr" bIns="0" lIns="0"
              spcFirstLastPara="1" rIns="0" wrap="square" tIns="0">
      <a:noAutofit/>
    </a:bodyPr>
    <a:lstStyle/>
    <a:p>
      <a:pPr indent="0" lvl="0" marL="0" marR="0" rtl="0" algn="ctr">
        <a:lnSpc><a:spcPct val="100000"/></a:lnSpc>
        <a:spcBef><a:spcPts val="0"/></a:spcBef>
        <a:spcAft><a:spcPts val="0"/></a:spcAft>
        <a:buNone/>
      </a:pPr>
      <a:r><a:t/></a:r>
      <a:endParaRPr sz="600">
        <a:latin typeface="Poppins"/>
        <a:ea typeface="Poppins"/>
        <a:cs typeface="Poppins"/>
        <a:sym typeface="Poppins"/>
      </a:endParaRPr>
    </a:p>
  </p:txBody>
</p:sp>'''
    slide.shapes._spTree.append(etree.fromstring(xml_str))


def _is_grade_value(text):
    t = text.strip()
    if t == 'X.X':
        return True
    return _is_number(t)


def update_grades_and_labels(slide, atscale_avg, client_avg, client_name):
    """Fill the per-block average grades and swap [CLIENT] placeholders."""
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        text = shape.text_frame.text.strip()
        lft = shape.left / 914400
        top = shape.top / 914400

        if 2.0 < lft < 5.5 and 0.7 < top < 1.1 and _is_grade_value(text):
            for p in shape.text_frame.paragraphs:
                for r in p.runs:
                    if _is_grade_value(r.text):
                        r.text = f"{atscale_avg:.1f}"

        if lft > 8.5 and 0.7 < top < 1.1 and _is_grade_value(text):
            for p in shape.text_frame.paragraphs:
                for r in p.runs:
                    if _is_grade_value(r.text):
                        r.text = f"{client_avg:.1f}"

        for p in shape.text_frame.paragraphs:
            runs = p.runs
            if len(runs) >= 2 and 'Grade' in runs[1].text:
                runs[0].text = client_name
                break
            for r in p.runs:
                if '[CLIENT]' in r.text:
                    r.text = r.text.replace('[CLIENT]', client_name)

    for shape in slide.shapes:
        if shape.top / 914400 > 5.2 and shape.left / 914400 < 1.0:
            for t_elem in shape.element.findall(f'.//{A_NS}t'):
                if t_elem.text and 'self-assessment' in t_elem.text.lower():
                    t_elem.text = f"{client_name} self-assessment"


def _replace_placeholders(slide, mapping):
    """Replace [TOKEN] occurrences across all runs (title slide etc.)."""
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for t_elem in shape.element.findall(f'.//{A_NS}t'):
            if not t_elem.text:
                continue
            for token, val in mapping.items():
                if token in t_elem.text:
                    t_elem.text = t_elem.text.replace(token, val)


def _match_bb(bb_name, takeaways_dict):
    """Case-insensitive match for building block names."""
    if bb_name in takeaways_dict:
        return takeaways_dict[bb_name]
    lo = bb_name.lower()
    for k, v in takeaways_dict.items():
        if k.lower() == lo:
            return v
    return None


def _clear_tk_area(slide):
    """Remove only red/colored-border placeholder boxes from the KT area.
    Shapes with text (column headers, existing content) are left untouched
    to avoid corrupting the template layout."""
    from pptx.oxml.ns import qn
    for sh in list(slide.shapes):
        l = sh.left  / 914400
        t = sh.top   / 914400
        if not (l >= TK_KT_LEFT - 0.1 and TK_ROW_TOP - 0.2 <= t <= TK_ROW_BOTTOM + 0.1):
            continue
        # Keep any shape that has real text — those are column headers or content
        if sh.has_text_frame and sh.text_frame.text.strip():
            continue
        # Only remove shapes that carry a solid-fill border line (= placeholder boxes)
        try:
            ln = sh.element.find('.//' + qn('a:ln'))
            if ln is not None and ln.find('.//' + qn('a:solidFill')) is not None:
                sh._element.getparent().remove(sh._element)
        except Exception:
            pass


def render_takeaways_on_slide(slide, items):
    """Render KTs in the 'Key takeaways' column and initiatives in the
    'Initiatives recommended' column, matching the template layout.
    Highlighted items get a red border box spanning both columns."""
    _clear_tk_area(slide)
    if not items:
        return
    n = len(items)
    available = TK_ROW_BOTTOM - TK_ROW_TOP
    row_h = min(0.60, available / n)
    total_h = row_h * n
    start_t = TK_ROW_TOP + (available - total_h) / 2   # center vertically

    font_size = max(5.0, min(7.0, row_h * 72 * 0.22))   # same size for KT and initiative
    pad_v = max(0.018, row_h * 0.07)
    # full span used for the red highlight box
    full_w = TK_INIT_LEFT + TK_INIT_WIDTH - TK_KT_LEFT

    for i, it in enumerate(items):
        t = start_t + i * row_h
        h = row_h - 0.006
        highlighted = it.get('highlighted', False)
        takeaway   = (it.get('takeaway')   or '').strip()
        initiative = (it.get('initiative') or '').strip()

        if highlighted:
            # Light pink background spanning both columns
            _add_rect(slide, TK_KT_LEFT, t, full_w, h, "FEF0F0")
            # Red border box
            border = slide.shapes.add_shape(
                MSO_SHAPE.RECTANGLE,
                to_emu(TK_KT_LEFT), to_emu(t), to_emu(full_w), to_emu(h))
            border.fill.background()
            border.line.color.rgb = RGBColor.from_string(TK_HIGHLIGHT_BORDER)
            border.line.width = Pt(1.5)
            border.shadow.inherit = False

        # Key takeaway text (left column)
        _add_text(slide, TK_KT_LEFT + 0.04, t + pad_v,
                  TK_KT_WIDTH - 0.06, h - 2 * pad_v,
                  takeaway, font_size, "1A1A2E",
                  wrap=True, anchor=MSO_ANCHOR.MIDDLE)

        # Initiative text (right column, same font size)
        if initiative:
            _add_text(slide, TK_INIT_LEFT + 0.04, t + pad_v,
                      TK_INIT_WIDTH - 0.06, h - 2 * pad_v,
                      initiative, font_size, "2D5A6B",
                      wrap=True, anchor=MSO_ANCHOR.MIDDLE)


# ── Roadmap slide (slide 23 "Gantt view") ───────────────────────────────────
# Coordinates lifted from the template's Gantt slide (inches).
ROADMAP_SLIDE = 23
RM_PLOT_L, RM_PLOT_W = 2.66, 6.23      # timeline plot area
RM_LABEL_L, RM_LABEL_W = 0.62, 1.98    # left initiative-label column (starts right of the axis title)
RM_LABEL_SIZE = 6                      # small enough to wrap long names onto 2 lines
RM_ROWS_T, RM_ROWS_H = 1.03, 3.02      # rows band
RM_MONTH_T = 0.87                      # month header row (above the rows)
RM_BAR_H = 0.085
RM_CYC_T, RM_CYC_H = 4.17, 0.20        # bottom cycle bars
RM_CYC_BG  = ["E8EDF8", "EDF0FA", "F0F2FC"]   # cycle column tints
RM_CYC_BAR = ["1800FF", "2E46FA", "6B7EC9"]   # bottom cycle bar blues

# Exact per-building-block pastel from the template's "Building Blocks" legend.
ROADMAP_BLOCK_COLORS = {
    "sales hiring & ramp-up":         "BDD3F3",
    "sales enablement":               "B4C5DF",
    "sales performance management":   "DBE3F0",
    "talent management":              "98B5FE",
    "demand generation":              "B9CDD5",
    "sales execution":                "EBC5D0",
    "client relationship":            "C5C3DF",
    "revenue operations":             "C8C5C5",
}


def _block_hex(block):
    key = re.sub(r'^\s*\d+[.)]\s*', '', block or '').strip().lower()
    return ROADMAP_BLOCK_COLORS.get(key, "C8C5C5")


def _add_rect(slide, l, t, w, h, fill_hex, rounded=False):
    shp = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE,
        to_emu(l), to_emu(t), to_emu(w), to_emu(h))
    shp.fill.solid()
    shp.fill.fore_color.rgb = RGBColor.from_string(fill_hex)
    shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def _add_text(slide, l, t, w, h, text, size, color_hex, bold=False, align=PP_ALIGN.LEFT,
              wrap=False, anchor=None, line_spacing=None):
    tb = slide.shapes.add_textbox(to_emu(l), to_emu(t), to_emu(w), to_emu(h))
    tf = tb.text_frame
    tf.word_wrap = wrap
    tf.auto_size = None
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    if anchor is not None:
        tf.vertical_anchor = anchor
    p = tf.paragraphs[0]
    p.alignment = align
    if line_spacing is not None:
        p.line_spacing = line_spacing
    r = p.add_run()
    r.text = text
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.name = "Poppins"
    r.font.color.rgb = RGBColor.from_string(color_hex)
    return tb


def render_roadmap_slide(prs, roadmap):
    """Replace the template Gantt with the app's roadmap (items, cycles, weights)."""
    items = (roadmap or {}).get('items') or []
    if not items or len(prs.slides) < ROADMAP_SLIDE:
        return
    slide = prs.slides[ROADMAP_SLIDE - 1]

    cycles = max(1, int(roadmap.get('cycles') or 1))
    weights = roadmap.get('weights') or [1.0 / cycles] * cycles
    if len(weights) != cycles:
        weights = [1.0 / cycles] * cycles
    tot = sum(weights) or 1.0
    weights = [w / tot for w in weights]

    # Clear the dynamic plot band (keep title, subtitle, rotated axis label at
    # L<0, header band, and the Building Blocks legend below T=4.45).
    for sh in list(slide.shapes):
        top = sh.top / 914400
        left = sh.left / 914400
        if 0.85 <= top <= 4.45 and left >= 0.2:
            sh._element.getparent().remove(sh._element)

    # Cycle background columns + bottom cycle bars.
    cum = 0.0
    for k in range(cycles):
        x = RM_PLOT_L + cum * RM_PLOT_W
        w = weights[k] * RM_PLOT_W
        _add_rect(slide, x, RM_ROWS_T, w, RM_ROWS_H, RM_CYC_BG[k % len(RM_CYC_BG)])
        _add_rect(slide, x, RM_CYC_T, w, RM_CYC_H, RM_CYC_BAR[k % len(RM_CYC_BAR)], rounded=True)
        _add_text(slide, x, RM_CYC_T + 0.012, w, RM_CYC_H, f"Cycle {k + 1}", 7, "FFFFFF",
                  bold=True, align=PP_ALIGN.CENTER)
        cum += weights[k]

    # Month axis: equal columns labelled from the app, with separator lines.
    month_labels = roadmap.get('monthLabels') or []
    months = max(1, int(roadmap.get('months') or len(month_labels) or 1))
    mw = RM_PLOT_W / months
    for i in range(months):
        mx = RM_PLOT_L + i * mw
        name = month_labels[i] if i < len(month_labels) else ""
        _add_text(slide, mx, RM_MONTH_T, mw, 0.16, name, 6.5, "42718A",
                  bold=True, align=PP_ALIGN.CENTER)
        if i > 0:
            _add_rect(slide, mx - 0.004, RM_ROWS_T, 0.008, RM_ROWS_H, "D9D9D9")

    # Rows: numbered label + a block-coloured bar positioned on the 0..1 timeline.
    n = min(len(items), 25)
    row_h = min(0.155, RM_ROWS_H / n)
    # Size the label so two tight lines fit inside the row (no overflow into the
    # neighbouring rows). ~0.9 line-spacing, 0.85 fudge for leading; 72pt = 1in.
    lbl_size = max(4.0, min(RM_LABEL_SIZE, (row_h * 72 / 2) * 0.85))
    for i in range(n):
        it = items[i]
        cy = RM_ROWS_T + i * row_h + row_h / 2
        # Wrap long names onto up to 2 lines, vertically centred on the row.
        _add_text(slide, RM_LABEL_L, cy - row_h / 2, RM_LABEL_W, row_h,
                  f"{i + 1}. {it.get('label', '')}", lbl_size, "19323F",
                  wrap=True, anchor=MSO_ANCHOR.MIDDLE, line_spacing=0.9)
        s = max(0.0, min(1.0, float(it.get('start', 0) or 0)))
        e = max(s, min(1.0, float(it.get('end', s) or s)))
        bx = RM_PLOT_L + s * RM_PLOT_W
        bw = max(0.06, (e - s) * RM_PLOT_W)
        _add_rect(slide, bx, cy - RM_BAR_H / 2, bw, RM_BAR_H, _block_hex(it.get('block', '')), rounded=True)


def build_deck(template_file, xlsx_file, client_name, segment=None, date=None, roadmap=None, takeaways=None):
    """Generate the filled deck. Returns the .pptx as bytes.

    `template_file` / `xlsx_file` are paths or binary file-likes.
    """
    prs = Presentation(template_file)
    topics_by_bb, bb_avgs = parse_self_assessment(xlsx_file)

    # Title-slide placeholders (cheap; harmless if a token is absent).
    title_map = {'[CLIENT]': client_name}
    if segment:
        title_map['[SEGMENT]'] = segment
    if date:
        title_map['[DATE]'] = date
    for slide in prs.slides:
        _replace_placeholders(slide, title_map)

    for slide_num, bb_name in SLIDE_BB_MAP.items():
        slide = prs.slides[slide_num - 1]

        # KT/initiative rendering is independent of the xlsx data — always run it.
        bb_items = _match_bb(bb_name, takeaways) if takeaways else []
        render_takeaways_on_slide(slide, bb_items or [])

        # Dots + grades require xlsx data; skip the rest if not available.
        avgs = bb_avgs.get(bb_name)
        if avgs is None:
            continue
        ca, aa = avgs['client_avg'], avgs['atscale_avg']
        topics = topics_by_bb[bb_name]
        y_list = SLIDE_Y_CENTERS[slide_num]
        n = min(len(topics), len(y_list))

        update_grades_and_labels(slide, aa, ca, client_name)

        spTree = slide.shapes._spTree
        for el in [s._element for s in slide.shapes if is_placeholder_dot(s)]:
            spTree.remove(el)

        for i in range(n):
            y_top = y_list[i] - DOT_WIDTH / 2
            add_dot(slide, score_to_x(topics[i]['rating']), y_top, CLIENT_COLOR)
            add_dot(slide, score_to_x(topics[i]['atscale']), y_top, ATSCALE_COLOR)

    if roadmap:
        render_roadmap_slide(prs, roadmap)

    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Fill the Revenue Audit deck from a self-assessment xlsx.")
    p.add_argument("--template", required=True)
    p.add_argument("--xlsx", required=True)
    p.add_argument("--client", required=True)
    p.add_argument("--segment", default=None)
    p.add_argument("--date", default=None)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    data = build_deck(a.template, a.xlsx, a.client, a.segment, a.date)
    with open(a.output, "wb") as f:
        f.write(data)
    print(f"✓ Done → {a.output} ({len(data)//1024} KB)")
