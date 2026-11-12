# The reel

A short film about pine, drawn by code: a mocked terminal, editor and phone that play a script.
Nothing in it is recorded.

| File | What it is |
| --- | --- |
| `reel.html` | the page the film is drawn on |
| `engine.js` | plays a script: typing, clicks, the camera, captions |
| `story.js` | the script, scene by scene |
| `render.mjs` | draws the film frame by frame in a headless browser and hands the frames to ffmpeg |
| `sound.py` | makes the typing and click sounds from the cues the render writes down |
| `assets/` | the logo and the font (JetBrains Mono, under the SIL Open Font License) |

## Rendering

It needs `ffmpeg`, and Python 3 with numpy for the sound.

```bash
node reel/render.mjs
```

writes `reel/pine-reel.mp4`. A part of it, or single frames to look at:

```bash
node reel/render.mjs --from 20 --to 30
```

```bash
node reel/render.mjs --at 3.2,12,40
```

What the render writes (`*.mp4`, `sfx.wav`, `sfx.json`, `frames/`) is not kept in the repository.

## Pictures you bring yourself

The film shows four things that are other people's work, so they are not in the repository.
Put your own into `assets/` under these names; without them the film still renders, with a
plain dark backdrop and without those pictures.

| File | What the film shows there |
| --- | --- |
| `wallpaper.jpg` | the desktop backdrop behind the windows, a wide picture (16:9) |
| `meme.jpg` | the "This is fine" picture the agent downloads in the first scene (the script names its address) |
| `cones.jpg` | a photo of pine cones that is dropped into the terminal |
| `spag-00.jpg` to `spag-39.jpg` | 40 square frames of the video the agent plays (the script names its address) |
