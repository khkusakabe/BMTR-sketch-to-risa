"""Write a RISA-3D (.r3d) model from the framing saved by the editor.

The .r3d format is plain text made of [SECTION] <count> ... [END_SECTION] blocks.
We start from a model saved by RISA-3D 23 (templates/risa3d_template.r3d), keep its
global settings, materials and load cases, and replace the geometry with ours.
Units are the template's (feet / kips); the plan lies in the X-Z plane at the story height
(Y = 0 when no columns are added).
"""
import os
import re
import uuid

APP_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(APP_DIR, "templates", "risa3d_template.r3d")

# Blocks whose records refer to the template's nodes/members: emptied.
EMPTY = ["DIAPHRAGMS", "DRIFT_DEFS", "PLATES", "WALLPANELS", "NODE_LOADS",
         "DIRECT_DISTRIBUTED_LOADS", "AREA_LOADS", "SURFACE_LOADS", "SAVED_SELECTION_STATES"]

# Member rows per data block, modelled on the template's members: M70 is a
# pinned-pinned A992 floor beam (release code 3120), M59 an A992 column (code 48,
# exactly as RISA itself saved it; verified to load in RISA-3D 23).
# {L} = label, {S} = shape, {I}/{J} = node numbers, {G} = GUID.
# None = copy the template member's row in that block, swapping in our label.
_TAIL = ' 0.000000 0.000000 0.000000 0.000000 "                                " "                                " 0.000000 "                                " 0.000000 0;'
MEMBER_ROWS = {
    ".MEMBERS_MAIN_DATA": {
        "beam": '{L} "Wide Flange                     " {S} {I} {J} 0 0.000000 -1 0 1 1 2 3120 0.000000 0.000000 1 0 65563 1 -1 -1 -1 1 0.000000 0 0 0 0 0' + _TAIL,
        "column": '{L} "Wide Flange                     " {S} {I} {J} 0 0.000000 -1 0 0 1 2 48 0.000000 0.000000 1 0 19 0 -1 -1 -1 1 0.000000 0 0 0 0 0' + _TAIL,
    },
    ".MEMBERS_DESIGN_PARAMETERS": None,
    ".MEMBERS_BRB_DATA": None,
    ".MEMBERS_SUPPLEMENTARY_DATA": {
        "beam": '{L} 0 0 0 -1 -1 917518 -1 "{G}" 0 0 0 "                                ";',
        "column": '{L} 0 0 0 -1 -1 917518 -1 "{G}" 0 0 0 "                                ";',
    },
    ".MEMBERS_DETAILING_DATA": None,
    ".MEMBERS_DESIGN_CALCMODE_PARAMETERS": None,
}
TEMPLATE_MEMBER = {"beam": "M70", "column": "M59"}

_BC = " 0 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 -1 -1 0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0 0;"
BC = {"pinned": "{N} 4 4 4 0 0 0" + _BC, "fixed": "{N} 4 4 4 4 4 4" + _BC}


def label(text, width=32):
    return '"' + text[:width].ljust(width) + '"'


def shape_name(size):
    """'W14x22' -> 'W14X22' (RISA's spelling)."""
    return re.sub(r"\s+", "", size).upper()


def _find(lines, name, start=0):
    """Index range (header, end) of block `name` (e.g. 'NODES' or '.MEMBERS_MAIN_DATA')."""
    dots = len(name) - len(name.lstrip("."))
    bare = name.lstrip(".")
    head = re.compile(r"^\[" + re.escape(name) + r"\](\s*<\d+>)?\s*$")
    end = "[" + "." * dots + "END_" + bare + "]"
    for i in range(start, len(lines)):
        if head.match(lines[i]):
            for j in range(i + 1, len(lines)):
                if lines[j].strip() == end:
                    return i, j
    raise KeyError(f"block {name} not found in template")


def _replace(lines, name, rows, counted=True):
    i, j = _find(lines, name)
    header = f"[{name}]" + (f" <{len(rows)}>" if counted else "")
    lines[i:j + 1] = [header] + rows + [lines[j]]


def build(frame, title="Framing from sketch"):
    """Return the .r3d text for a frame dict as saved by the editor."""
    with open(TEMPLATE, encoding="latin-1") as f:
        lines = f.read().split("\n")

    # Title / company line
    i, j = _find(lines, "..MODEL_TITLE")
    lines[i + 1:j] = [title]
    i, j = _find(lines, "..COMPANY_NAME")
    lines[i + 1:j] = [f"From {frame.get('source', 'a sketch')} (RISA-3D Control Panel)"]

    # Optional columns: the floor goes up to the story height and a column runs
    # from a base node at Y = 0 to every support point.
    cols = frame.get("columns") or None
    elev = float(cols["height"]) if cols else 0.0

    # Nodes: plan (x, y) -> RISA (X, Z), with the top of the sketch at Z = 0.
    ymax = max(n["y"] for n in frame["nodes"])
    num, xz = {}, {}
    node_rows = []

    def add_node(x, y, z):
        k = len(node_rows) + 1
        node_rows.append(f'{label("N%d" % k)}   {x:.12e}   {y:.12e}   {z:.12e}'
                         f'   {0.0:.12e} 851981 0 0 -1 -1 0;')
        return k

    for n in frame["nodes"]:
        num[n["id"]] = add_node(n["x"], elev, ymax - n["y"])
        xz[n["id"]] = (n["x"], ymax - n["y"])
    supports = [i for i in frame.get("supports", []) if i in num]
    column_members = []
    if cols:
        base = []
        for i in supports:
            b = add_node(xz[i][0], 0.0, xz[i][1])
            base.append(b)
            column_members.append({"kind": "column", "size": cols["size"], "I": b, "J": num[i]})
        bc_nodes, fix = base, cols.get("base", "pinned")
    else:
        bc_nodes, fix = [num[i] for i in supports], "pinned"
    _replace(lines, "NODES", node_rows)
    _replace(lines, "BOUNDARY_CONDITIONS", [BC[fix].format(N=k) for k in bc_nodes])

    # Shapes used. The section properties are filled in by RISA from its database
    # when the model is opened, so the list only needs the names.
    _replace(lines, "SHAPES_LIST", [])

    # Members: one row in every member data block, modelled on the template row.
    template_rows = {}
    for block in MEMBER_ROWS:
        i, j = _find(lines, block)
        rows = lines[i + 1:j]
        for kind, lab in TEMPLATE_MEMBER.items():
            match = [r for r in rows if r.startswith(label(lab))]
            template_rows[block, kind] = match[0] if match else rows[0]  # calcmode rows have no label
    members = [{"kind": "beam", "size": m["size"], "I": num[m["i"]], "J": num[m["j"]]} for m in frame["members"]]
    members += column_members
    for k, m in enumerate(members, 1):
        m.update(L=label("M%d" % k), S=label(shape_name(m["size"] or "W8X10")), G=str(uuid.uuid4()))
    for block, fmt in MEMBER_ROWS.items():
        rows = []
        for m in members:
            if fmt:
                rows.append(fmt[m["kind"]].format(**m))
            else:  # copy the template member's row, swapping in our label if it has one
                rows.append(re.sub(r'^"[^"]*"', m["L"], template_rows[block, m["kind"]]))
        _replace(lines, block, rows)

    for block in EMPTY:
        if block == "WALLPANELS":
            i, j = _find(lines, block)
            lines[i:j + 1] = ["[WALLPANELS] <0>", lines[j]]
        else:
            _replace(lines, block, [])

    # Load cases stay, but their load counts must be zero now that the loads are gone.
    i, j = _find(lines, "BASIC_LOAD_CASES")
    for k in range(i + 1, j):
        lines[k] = re.sub(r'^(\d+ "[^"]*" )\d+ \d+ \d+ \d+ \d+ \d+', r"\g<1>0 0 0 0 0 0", lines[k])

    return "\n".join(lines)


def write(frame, path, title=None):
    text = build(frame, title or os.path.splitext(os.path.basename(path))[0])
    with open(path, "w", encoding="latin-1", newline="\r\n") as f:
        f.write(text)
    return path
