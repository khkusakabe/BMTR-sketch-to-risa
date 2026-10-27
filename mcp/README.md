# Sketch to RISA MCP server

Lets Claude (Claude Desktop or Claude Code) build RISA-3D models with the team's generators. You show Claude a sketch or a plan, Claude reads it, confirms the dimensions and sizes with you, and calls a tool that writes the `.r3d`.

No API key is needed for this: your own Claude does the reading. The server only runs the generators in `Final Models/` on your PC. It has no dependencies beyond Node.js (18 or newer).

## Tools

| Tool | What it writes |
|---|---|
| `build_moment_frame` | Two-story, one-bay steel moment frame: bay, story heights, W shapes, base, beam-end fixity, beam and lateral loads |
| `build_roof_framing` | One-story column grid plus roof beams (B1 end bays pinned, B2 middle bays fixed, B3 interior pinned), loads by tributary area |
| `build_foundation_plan` | The same column grid, columns only |
| `get_sketch_reading_instructions` | The team's sketch-reading rules and the JSON format for a reading (the same prompt the website gives you) |
| `convert_sketch_reading` | Checks a reading and turns it into generator inputs, plus a copy ready to paste into the website |
| `list_shapes` | AISC W or HSS names the generators accept, with an optional filter |
| `get_defaults` | The defaults a generator uses for anything you leave out |

Every model gets basic load cases and ASCE 7-22 ASD load combinations. Files go to `out/` in the repo unless you pass `output_dir`. Pass `template_path` to use your own RISA-saved `.r3d` as the template.

## Set up

### Claude Code

Open the repo folder in Claude Code. The repo's `.mcp.json` registers the server, and Claude Code asks you to approve it the first time. Check it with `/mcp`.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings > Developer > Edit Config), with the path to your clone:

```json
{
  "mcpServers": {
    "sketch-to-risa": {
      "command": "node",
      "args": ["C:\path\to\BMTR-sketch-to-risa\mcp\server.js"]
    }
  }
}
```

Restart Claude Desktop. The tools show up under the tools menu.

## Try it

> Here's a sketch of a two-story moment frame. Read it with the Sketch to RISA rules, check the bay, story heights and sizes with me, then build it.

Claude gets the rules from `get_sketch_reading_instructions`, reads the sketch, runs `convert_sketch_reading`, confirms with you, then calls `build_moment_frame`. You can also paste its reading into the website's **Use Claude's answer** box.

## Note

The output is a starting model. The engineer opens it in RISA-3D and checks geometry, sections, loads, supports and connections, and owns the design.
