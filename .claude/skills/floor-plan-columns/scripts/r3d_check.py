#!/usr/bin/env python3
"""Check a RISA-3D .r3d text file for the errors RISA treats as fatal.

  python r3d_check.py model.r3d [--template template.r3d]

- every "[TAG] <n>" block has exactly n records before its END tag
- quoted labels are exactly the widths set in [LABEL_LENGTHS]
- boundary conditions and members point at nodes that exist
- every member's shape is in [SHAPES_LIST]; member labels and IDs are unique
- with --template: every section of the template is still present, in the same order
"""
import argparse, re, sys
from collections import Counter


def blocks(text):
    """yield (tag, declared_count, records) for every counted block"""
    lines = text.replace("\r\n", "\n").split("\n")
    stack = []
    out = []
    for i, l in enumerate(lines):
        m = re.match(r"^\[(\.*)([A-Z0-9_ :#]+?)\]\s*<(\d+)>\s*$", l.strip())
        if m:
            stack.append([m.group(1) + m.group(2), int(m.group(3)), [], i])
            continue
        m = re.match(r"^\[(\.*)END_([A-Z0-9_ :#]+?)\]\s*$", l.strip())
        if m and stack and stack[-1][0] == m.group(1) + m.group(2):
            tag, n, recs, at = stack.pop()
            out.append((tag, n, recs, at))
            if stack:
                stack[-1][2].append("<sub>")
            continue
        if stack and l.strip() and not l.strip().startswith("//") and not l.strip().startswith("["):
            stack[-1][2].append(l)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("r3d"); ap.add_argument("--template")
    a = ap.parse_args()
    text = open(a.r3d, encoding="utf-8", errors="replace").read()
    errs = []
    bl = blocks(text)
    byname = {}
    for tag, n, recs, at in bl:
        real = [r for r in recs if r != "<sub>"]
        # blocks that hold sub-blocks or multi-line free text are not record-counted
        if tag in ("OS_VERSION", ".PROJECT_DESCRIPTION", "..COMPANY_NAME", "..DESIGNER_NAME", "..MODEL_TITLE", "..JOB_NUMBER", "..MODEL_NOTES", "TIME_HISTORY_INPUT"):
            pass
        elif "<sub>" in recs or tag.startswith("WOOD_SCHEDULE") or tag.startswith("COLDFORM_SCHEDULE") or tag in (".SEISMIC_PARAMETERS", ".WIND_PARAMETERS", ".WOOD_MATERIAL", "RISA_3D_FINISH"):
            pass
        elif len(real) != n:
            errs.append(f"[{tag}] says <{n}> but has {len(real)} records (line {at + 1})")
        byname.setdefault(tag, real)

    LL = [int(v) for v in byname.get("LABEL_LENGTHS", ["32 " * 24])[0].replace(";", "").split()]
    wn, wm, ws = LL[7], LL[8], LL[4]
    nodes = byname.get("NODES", [])
    for r in nodes:
        q = re.findall(r'"([^"]*)"', r)
        if not q or len(q[0]) != wn:
            errs.append(f"node label not {wn} wide: {r[:50]}")
    nn = len(nodes)
    for r in byname.get("BOUNDARY_CONDITIONS", []):
        k = int(r.split()[0])
        if not 1 <= k <= nn:
            errs.append(f"boundary condition on missing node {k}")
    shapes = {re.findall(r'"([^"]*)"', r)[0].strip().upper() for r in byname.get("SHAPES_LIST", [])}
    for r in byname.get("SHAPES_LIST", []):
        q = re.findall(r'"([^"]*)"', r)[0]
        nums = r[r.rindex('"') + 1:].replace(";", "").split()
        if len(q) != ws:
            errs.append(f"shape label not {ws} wide: {q}")
        if q.strip().startswith("W") and len(nums) != 27:
            errs.append(f"W shape record has {len(nums)} numbers, expected 27: {q.strip()}")
    main = byname.get(".MEMBERS_MAIN_DATA", [])
    labels = []
    for r in main:
        q = re.findall(r'"([^"]*)"', r)
        labels.append(q[0].strip())
        if len(q[0]) != wm:
            errs.append(f"member label not {wm} wide: {q[0]}")
        if q[2].strip().upper() not in shapes:
            errs.append(f"member {q[0].strip()} uses shape {q[2].strip()} not in SHAPES_LIST")
        t = r.split('"')[6].split()
        i, j = int(t[0]), int(t[1])
        if not (1 <= i <= nn and 1 <= j <= nn) or i == j:
            errs.append(f"member {q[0].strip()} has bad nodes {i},{j}")
    dup = [k for k, v in Counter(labels).items() if v > 1]
    if dup:
        errs.append("duplicate member labels: " + ", ".join(dup[:5]))
    for tag in (".MEMBERS_DESIGN_PARAMETERS", ".MEMBERS_BRB_DATA", ".MEMBERS_SUPPLEMENTARY_DATA", ".MEMBERS_DETAILING_DATA", ".MEMBERS_DESIGN_CALCMODE_PARAMETERS"):
        recs = byname.get(tag)
        if recs is not None and len(recs) != len(main):
            errs.append(f"[{tag}] has {len(recs)} records, members: {len(main)}")
        if recs and recs[0].startswith('"'):
            lab2 = [re.findall(r'"([^"]*)"', r)[0].strip() for r in recs]
            if lab2 != labels:
                errs.append(f"[{tag}] labels are not in the same order as the members")
    ids = re.findall(r'"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"', "\n".join(byname.get(".MEMBERS_SUPPLEMENTARY_DATA", [])))
    if len(ids) != len(set(ids)):
        errs.append("member IDs are not unique")
    if a.template:
        tt = [t for t, *_ in blocks(open(a.template, encoding="utf-8", errors="replace").read())]
        mine = [t for t, *_ in bl]
        if [t for t in mine if t in tt] != [t for t in tt if t in mine] or set(tt) - set(mine):
            errs.append("section order differs from the template, or sections are missing: " + ", ".join(sorted(set(tt) - set(mine))[:5]))
    print(f"{a.r3d}: {nn} nodes, {len(byname.get('BOUNDARY_CONDITIONS', []))} supports, {len(main)} members, {len(shapes)} shapes")
    if errs:
        print("FAIL:", *errs[:25], sep="\n  ")
        sys.exit(1)
    print("r3d structure OK")


if __name__ == "__main__":
    main()
