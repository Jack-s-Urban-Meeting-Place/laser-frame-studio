# Laser Frame Studio

Turn a set of animation frames (JPG or PNG) into a `.ild` laser animation for the
**LaserCube** (built and tested on the LaserCube Ultra 7.5W with LaserOS).

## To install
1. Download the zip of this repo. (look for a drop down on a green button that says code, then download zip)
2. Unzip the file. Keep all files together in that folder.
3. Double-click `laser-frame-studio.html` to open it in a browser.

This project is :
- **Private.** Images are processed on your computer and never uploaded anywhere.
- **Free and open source** under the [MIT License](LICENSE). Source:
  [github.com/Jack-s-Urban-Meeting-Place/laser-frame-studio](https://github.com/Jack-s-Urban-Meeting-Place/laser-frame-studio)

## How to use it

1. Open `laser-frame-studio.html`. New here? Open **Examples & tips** and click
   **Try the fox sample animation**.
2. **Upload Frames:** drop in your numbered frames (`walk_01.jpg`, `walk_02.jpg` …).
3. **Tracing / Simplify / Color:** adjust until the laser preview looks clean.
   The "Cleaned" source view shows exactly what is being traced.
4. **Wall canvas:** the dashed box on the laser preview is the safe area on the
   JUMP wall (tall, about 2 wide × 3 tall). Art is fitted inside it automatically.
   Use the sliders to adjust it for another wall, or **Reset to the JUMP wall**.
5. **Export:** click **Download .ild**.
6. In **LaserOS**, import the `.ild` file and set the playback speed (fps).

## What art works best

Bold dark lines on white paper, or simple solid shapes. A few bright colors are fine.
For the JUMP wall, draw tall (portrait paper) and keep away from the edges.
Photos, shading, tiny detail and faint pencil don't convert well. The app's
**Examples & tips** panel has picture examples and the limits.

## Files

| Path | What it is |
|---|---|
| `laser-frame-studio.html` | The app page (layout and all settings) |
| `css/styles.css` | Look and feel; colours are at the top |
| `js/*.js` | The code, one job per file (see the comment at the top of each) |
| `examples/` | Pictures used in the Examples & tips panel |
| `tools/ilda_inspect.py` | Prints a summary of any `.ild` file (Python 3) |
| `tools/make-sample.ps1` | Rebuilds the built-in sample animation |
| `AGENTS.md` | Detailed project notes for developers and AI assistants |

## Credits

Built by Jack's Urban Meeting Place (JUMP) with [Claude Code](https://claude.com/claude-code)
2.1.317 (model: Claude Opus 5.5). Writes the ILDA Image Data Transfer Format,
[ilda.com/technical.htm](https://www.ilda.com/technical.htm).
