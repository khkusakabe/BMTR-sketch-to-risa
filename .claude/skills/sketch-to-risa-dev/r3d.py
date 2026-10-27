"""Write a RISA-3D .r3d input file from a simple model dict.

Follows the record templates in RISA-3D Help, Appendix D (File Format).
Covers geometry only: units, label lengths, hot-rolled materials, section sets,
nodes, boundary conditions and members. Appendix D does not document loads or
load combinations, so those stay in the companion CSVs.
"""

LL = dict(grid=20, material=20, wood=32, secset=20, shape=32, design=32, rule=20,
          node=20, member=20, plate=20, footing=32, blc=30, moving=32, lc=79,
          selstate=200, viewstate=200, rebar=32, r=32, s=32, t=32, u=32)

BC = {"Reaction": 4, "Fixed": 1, "": 0, None: 0}

MATERIALS = {
    # label: E, G, nu, therm (x1e5 /F), density k/ft^3, Fy ksi, BIM id, Ry, Fu ksi, Rt
    "A992": (29000, 11154, 0.3, 0.65, 0.49, 50, 0, 1.1, 65, 1.1),
    "A500 Gr.C": (29000, 11154, 0.3, 0.65, 0.49, 50, 0, 1.3, 62, 1.2),
}


def q(label, n):
    label = str(label)
    if len(label) > n or '"' in label or ";" in label:
        raise ValueError(f"bad label {label!r}")
    return '"' + label.ljust(n) + '"'


def risa_shape(name):
    """AISC name -> RISA database name. HSS wall thickness goes to sixteenths (HSS5X5X3/8 -> HSS5X5X6)."""
    if name.upper().startswith("HSS"):
        d1, d2, t = name.upper()[3:].split("X")
        num, den = (t.split("/") + ["1"])[:2]
        sixteenths = round(16 * int(num) / int(den))
        return f"HSS{d1}X{d2}X{sixteenths}"
    return name.upper()


def fmt(v):
    return f"{v:.4f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def write_r3d(model):
    """model = {
        nodes: [(label, x, y, z)],
        bcs: {label: (tx, ty, tz, rx, ry, rz)}  using "Reaction" / "Fixed" / "",
        materials: [label, ...],
        secsets: [(label, shape, design_list, member_type, material_label, A, Iyy, Izz, J)],
        members: [(label, i_label, j_label, rotation_deg, secset_label)],
    }"""
    nidx = {n[0]: i + 1 for i, n in enumerate(model["nodes"])}
    mats = model["materials"]
    sets = model["secsets"]
    sidx = {s[0]: i for i, s in enumerate(sets)}
    out = []
    w = out.append

    w("[RISA-3D_INPUT_DATA]")
    w("[VERSION_NO] <1>"); w("15.00"); w("[END_VERSION_NO]")
    w("[PROGRAM_INFO] <1>"); w("64;"); w("[END_PROGRAM_INFO]")
    w("[OS_VERSION] <1>"); w("10 (Windows 10);"); w("[END_OS_VERSION]")

    w("[UNITS] <1>")
    w(" ".join(["0"] * 14) + ";")   # user units: ft, in, in, kips, k/ft, k/in, k-ft, k-ft/rad, ksf, ksi, ksi, k/ft^3, F
    w("[END_UNITS]")

    w("[LABEL_LENGTHS] <1>")
    w(" ".join(str(v) for v in LL.values()) + ";")
    w("[END_LABEL_LENGTHS]")

    w("[MATERIAL_PROPERTIES]")
    w(f"[.HR_STEEL_MATERIAL] <{len(mats)}>")
    for m in mats:
        E, G, nu, th, den, fy, bim, ry, fu, rt = MATERIALS[m]
        w(f"{q(m, LL['material'])} {E} {G} {nu} {th} {den} {fy}, {bim}, {ry}, {fu}, {rt};")
    w("[.END_HR_STEEL_MATERIAL]")
    w("[END_MATERIAL_PROPERTIES]")

    w("[SECTION_SETS]")
    w(f"[.HR_STEEL_SECTION_SETS] <{len(sets)}>")
    for lab, shape, dl, mtype, mat, A, Iyy, Izz, J in sets:
        w(f"{q(lab, LL['secset'])} {q(dl, LL['design'])} {q(risa_shape(shape), LL['shape'])} "
          f"{mtype} 1 {mats.index(mat)} 1 -1 {fmt(A)} {fmt(Iyy)} {fmt(Izz)} {fmt(J)};")
    w("[.END_HR_STEEL_SECTION_SETS]")
    w("[END_SECTION_SETS]")

    w(f"[NODES] <{len(model['nodes'])}>")
    for lab, x, y, z in model["nodes"]:
        w(f"{q(lab, LL['node'])} {fmt(float(x))} {fmt(float(y))} {fmt(float(z))} 0 0 0 0;")
    w("[END_NODES]")

    bcs = model["bcs"]
    w(f"[BOUNDARY_CONDITIONS] <{len(bcs)}>")
    for lab, codes in bcs.items():
        c = " ".join(str(BC[v]) for v in codes)
        w(f"{nidx[lab]} {c} -1 0 0 0 0 0 0;")
    w("[END_BOUNDARY_CONDITIONS]")

    w("[MEMBERS]")
    w(f"[.MEMBERS_MAIN_DATA] <{len(model['members'])}>")
    for lab, i, j, rot, ss in model["members"]:
        s = sets[sidx[ss]]
        mat_off = mats.index(s[4])
        # a I, b J, c K(0=none), d rotation, e secset offset, f T/C only (0), g design rules (-1),
        # h material type (1 = hot rolled), i material offset, j end releases (0 = none),
        # k I offset, l J offset, m physical (1), o top offset (0), p activation (19 = active)
        w(f"{q(lab, LL['member'])} {q(s[2], LL['design'])} {q(risa_shape(s[1]), LL['shape'])} "
          f"{nidx[i]} {nidx[j]} 0 {fmt(float(rot))} {sidx[ss]} 0 -1 1 {mat_off} 0 0 0 1 0 19;")
    w("[.END_MEMBERS_MAIN_DATA]")
    w("[END_MEMBERS]")

    w("[FINISH]")
    return "\r\n".join(out) + "\r\n"
