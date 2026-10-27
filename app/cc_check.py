"""Checker the Claude Code agent runs after each draft of the framing.

    python cc_check.py <sketch|plan> <workdir>

Reads <workdir>/framing.json, prints the problems found, writes the review drawing
(<workdir>/review.png) and appends a progress line to <workdir>/progress.log.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2

import sketch_agent as sa


def main(mode, workdir):
    with open(os.path.join(workdir, "framing.json")) as f:
        data = json.load(f)
    fr = sa.Framing.model_validate(data.get("framing", data))
    probs = sa.check(fr, origin_at_zero=(mode == "sketch"))
    if mode == "plan":
        import plan_agent
        with open(os.path.join(workdir, "plan.json")) as f:
            meta = json.load(f)
        img = cv2.imread(os.path.join(workdir, "page_full.jpg"))
        cv2.imwrite(os.path.join(workdir, "review.png"), plan_agent._small(plan_agent.overlay(fr, meta, img)))
    else:
        with open(os.path.join(workdir, "review.png"), "wb") as f:
            f.write(sa.render(fr))

    log = os.path.join(workdir, "progress.log")
    n = sum(1 for _ in open(log)) + 1 if os.path.exists(log) else 1
    with open(log, "a") as f:
        f.write(f"Round {n}: {len(fr.members)} members, {len(fr.supports)} columns, "
                f"grid {len(fr.x_grid)}x{len(fr.y_grid)}; {len(probs)} problem(s) from the checker\n")
    print(f"{len(fr.members)} members, {len(fr.supports)} supports, grid {len(fr.x_grid)} x {len(fr.y_grid)}.")
    print("Problems:" if probs else "No problems found by the automatic checks.")
    for p in probs:
        print(" - " + p)
    print("Review drawing written to review.png - open it with Read and compare it with the original.")


if __name__ == "__main__":
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception as e:  # report schema mistakes back to the agent instead of crashing
        print(f"framing.json could not be checked: {type(e).__name__}: {e}")
        sys.exit(1)
