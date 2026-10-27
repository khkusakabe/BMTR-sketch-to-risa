# Team skills

Claude Code skills shared by everyone on the team. Anyone who opens this repo in Claude Code gets them automatically.

## Add a skill

1. Make a folder here named for the skill, lowercase with dashes: `.claude/skills/<skill-name>/`.
2. Put a `SKILL.md` inside with this shape:

```markdown
---
name: <skill-name>
description: One or two sentences on what it does AND when to use it. Claude reads this to decide when to load the skill, so name the trigger words.
---

# <Skill title>

Added by: <your name> (@<github>)

The steps, file paths, commands and gotchas Claude should follow.
```

3. Optional: put scripts or reference files in the same folder and point to them from `SKILL.md`.
4. Commit on a branch and open a pull request.

## Tips

- One skill, one job. Several small skills beat one big one.
- Lead with the "when": the description is what gets it picked.
- Public sources only, nothing from your employer. Name the source of any engineering method.

## Skills so far

| Skill | What it does | Added by |
|---|---|---|
| `sketch-to-risa-dev` | How this repo fits together, how to run it and test with the samples, and the team's ground rules | Kei |
