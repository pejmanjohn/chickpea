# Chickpea art kit

The art kit is the one source that every multicolored Chickpea image builds from: Slack agent avatars, onboarding scenes, and the marketing site. It holds faceless chickpea bodies, a set of faces, onboarding poses, and a palette, plus a generator that renders any body in any palette color with any face.

The committed files in `assets/chickpea/` are the truth. The tools that made them run only on macOS, and nobody needs them to render an image.

## What the kit holds

- `assets/chickpea/palette.json` has 13 colors. Twelve match the agent avatar renders, keyed like their files (`01-sage` to `12-muted-berry`). The thirteenth, `brand`, is the orange of the onboarding poses. Each color has a display name, a body color in Lab and hex, a face kind (`ink`, or `cream` for `06-deep-moss` and `10-midnight-indigo`), and 9 lightness quantiles at the probabilities in `lightnessQuantiles`. The twelve avatar colors also record their render's scene: `background`, `floor`, `arch`, and `doorway`. `faces` holds the ink and cream fill colors.
- `assets/chickpea/manifest.json` lists every master: its file, kind (`stand` or `pose`), native palette color, body mask, ground line, felt Lab median, lightness quantiles, and `source`, the file it was cut from with the scale and offset that carry a source pixel to the master. A standing body records its native face and its face anchor, the point between the eyes. A pose records its face matte, and `recolor: false` with a `reason` when it cannot be recolored. `faces` lists each face matte with its anchor and source.
- `assets/chickpea/masters/` has 12 faceless standing bodies (`stand-01-sage.png` and so on) and 7 poses (`pose-hello.png` and so on). Each master has a body mask (`*.body.png`), white where recoloring applies and gray in proportion where a pixel mixes felt and a prop. Each pose also has a face matte (`*.face.png`) that marks its ink features.
- `assets/chickpea/faces/` has the face mattes `smile`, `line`, and `o`. A matte is white where the face covers the body.
- `scripts/chickpea-art.mjs` is the generator.
- `scripts/art/` has the maintenance tools that build the kit from source renders.

Every master is a 512 by 512 transparent PNG. The body's lowest point sits on row 448 (`groundY`), and the body is centered horizontally. Standing bodies are all 384 pixels tall. Poses keep their source scale.

## Render an image

Run the generator from the command line:

```sh
npm run art:chickpea -- stand-03-lilac 11-apricot lilac-apricot.png
npm run art:chickpea -- stand-01-sage 10-midnight-indigo sage.webp --face o --size 256
npm run art:chickpea -- pose-celebrate 06-deep-moss celebrate.png --shadow
```

The arguments are the master, the palette color, and the output file. The file extension picks PNG or WebP. Options:

- `--face NAME` puts a face from the kit on a standing body: `smile`, `line`, `o`, or `none`. The default is the face the body's render had. A pose carries its own face and refuses `--face`.
- `--size N` resizes the square image to N pixels.
- `--shadow` adds a soft contact shadow under the body. It is off by default.

Call it from code with the same options:

```js
import { renderChickpea } from './scripts/chickpea-art.mjs';

const png = await renderChickpea({ master: 'stand-08-seafoam', color: 'brand', face: 'smile' });
const webp = await renderChickpea({ master: 'pose-hello', color: '07-periwinkle', size: 256, format: 'webp' });
```

`renderChickpea` returns a `Buffer` and always gives the same bytes for the same options. These rules hold for every render:

- A master in its native color, with no face added, comes back pixel for pixel.
- Pixels outside the body mask never change, so props keep their colors. The alpha never changes.
- A face is ink on an `ink` color and cream on a `cream` color.
- A pose marked `recolor: false` renders only in its native color.

A Slack avatar must stay under 512 KiB. Felt texture compresses poorly: the 512-pixel avatar renders are 300 to 380 KB as PNG, and a transparent 512-pixel body is about 170 to 230 KB. Check the size of anything you upload.

## How recoloring works

The generator changes only the pixels its body mask covers.

- **Lightness** maps by rank. A pixel's lightness gets its rank among the master's 9 quantiles, and takes the lightness at that rank among the target color's quantiles, piecewise-linearly. Past the outer quantiles the map follows the outer segment, never steeper than 1.
- **Chroma** is the target's, scaled by the pixel's chroma relative to the master's felt median. For a master whose felt chroma is under 50, that ratio is damped toward 1 in proportion, because a weak source's chroma variation is mostly noise that a saturated target would turn into mottling.
- **Hue** is the target's.

Compressing texture is safe and stretching it is not. A body with a wide lightness range recolors cleanly into a color with a narrow one, but the reverse amplifies felt noise. `08-seafoam` and `09-warm-oat` have the widest ranges, and `02-coral`, `12-muted-berry`, and `10-midnight-indigo` the narrowest.

Faces composite after the recolor. The generator places the face matte so that its anchor lands on the body's face anchor, then fills it. Ink is the flat `faces.ink` color. Cream is `faces.cream`, darkened along about a pixel of the feature's rim, most at its lower edge, like the real deep-moss and midnight-indigo renders. A pose's own face is recolored the same way: the generator unmixes the ink out to recover the felt under it, recolors the felt, and fills the face.

## Make new art

### Source renders

Make a source render to this spec:

- A square canvas of 1024 pixels, or 2048 if that costs little more. The build scales it to the kit's size.
- One body color, in the brand orange for poses.
- A flat background in a color that is in no palette. Never fake transparency with a checkerboard.
- No cast shadow. Keep the baked darkening at the body's base and the felt texture. The generator has its own optional shadow.
- The body's base at 0.92 of the canvas height, so the body fills the render. The build then moves every master's base to row 448, 0.875 of the 512 canvas, which leaves room for props that hang below the body.
- A face drawn in near-black ink on a light body. The build finds a face by its eyes, measured at 512 pixels: two features of at least 50 pixels each, at least 60 pixels apart, and level within a quarter of that distance. A render without such eyes fails the build. Expressions come from the kit's face set. A new expression comes from a second render that differs from an existing one only in the face.
- Props that no rule mistakes for the body. The build takes as body every pixel connected to it whose Lab hue is between 48 and 92 degrees with chroma at least 0.74 times its lightness. It also takes any dark pixel touching the body as shading: lightness under 40, with hue between 15 and 74 degrees or chroma under 8. A prop that touches the body must stay outside both rules, or its pose is not recolorable.
- A background more than 40 RGB units from the body and from every prop, because the build keys a pose out of its background at that distance.

### How the build cuts a master

`node scripts/art/build-masters.mjs` rebuilds the whole kit and prints the lines for `allowedBinaryFiles` in `scripts/lib/source-export-policy.mjs`. It needs macOS, because `scripts/art/lift.swift` uses Vision. Pass `--debug DIR` to write each pose's mask overlay to `DIR`.

1. A standing body starts from Vision's subject lift, which gives a coarse alpha. Where an avatar arch touches the chickpea, the build paints the arch to the background color first, so Vision sees one subject (`ARCH_PAINT`).
2. Inside a band at the coarse edge, the build recomputes alpha by unmixing each pixel between the body's local color and the scene color next to it: the average of the pixels just outside the coarse mask, or the nearest sampled scene color when none is near. Where the two colors are too close to tell apart, it keeps Vision's alpha.
3. It closes and opens the alpha by 3 pixels, which rounds off steps that a floor or pillar corner leaves, then shaves and softens the edge by a pixel. It stops the soft edge 2.5 pixels from the solid body and fades out drips below the base.
4. Over the lowest 40 rows of the body, where it met a floor, the build fits a smooth contour: it blurs the solid shape and thresholds it with a 2-pixel ramp. Every pose base goes through the same step. The rest of the silhouette keeps its cut.
5. It gives the rim the color of the opaque interior, 3 pixels deep along the base, so no scene tint or old stair-step survives on the edge.
6. It finds the face, inpaints it with the surrounding felt plus felt texture from 70 pixels above, and scales the body to 384 pixels tall on the ground line.
7. A pose on a flat background is keyed against that background, which keeps props that float free of the body. An onboarding pose is already cut out with a hard edge, which the build softens the same way.
8. A pose's body mask comes from color and connectivity: felt in the body's hue connected to the body, the dark shading and ink it touches, and small seams between them. A felt island of at least 2000 pixels also counts, such as an arm behind a strap. Within 3 pixels of the body, a pixel that mixes felt and a prop gets the fraction of felt it holds, unmixed between the felt and the prop color next to it. No mask uses hand-drawn shapes.

### Add a color

1. Render a standing chickpea in the new color to the source spec, with a face.
2. Add a row to `STANDS` in `scripts/art/build-masters.mjs`: the palette key, display name, face name, `ink` or `cream`, the render's `file`, and `scene: 'flat'`.
3. Run the build on macOS. It cuts the body and measures the color and its lightness quantiles from the cut.
4. Replace the kit's lines in `allowedBinaryFiles` with the lines the build prints.
5. Run `node scripts/art/contact-sheet.mjs <dir>` and check the new color in `bodies.jpg`.

### Add a pose

1. Render the pose to the source spec.
2. Add `{ pose, file }` to `POSES` in `scripts/art/build-masters.mjs`. If a prop shares the body's hue and touches it, add `recolor: false` and a `reason`.
3. Run the build with `--debug DIR`, and check the overlay: body magenta, face cyan, props untouched.
4. Update `allowedBinaryFiles`, and check `poses.jpg` from the contact sheet.

### Add an expression

1. Render an existing standing chickpea again with only the face changed, ink on a light body. `09-warm-oat` and `08-seafoam` give the most contrast.
2. Add the face to `FACE_SOURCES` in `scripts/art/build-masters.mjs` as `{ file, scene: 'flat' }`.
3. Run the build, update `allowedBinaryFiles`, and check the new face on every body in `bodies.jpg`.

## Review the kit

`node scripts/art/contact-sheet.mjs <dir>` writes four review images. `bodies.jpg` shows every standing body in every color with every face. `poses.jpg` shows each pose in every color it allows, beside its masks. `edges.png` zooms into the edges where the avatar arch touched a body, and into both corners of every master's base, next to the same place in the source render. `seams.png` zooms into the seams where a pose's props meet its body, in the brand color and two recolors. Keep these images out of the repository.

The npm package leaves out the kit, the generator, and these tools (`!assets/chickpea`, `!scripts/art`, and `!scripts/chickpea-art.mjs` in `package.json#files`), because nothing at runtime reads them. This document stays out of the package too, since it is for work in the source repository.

`tests/chickpea-art.test.ts` checks the palette and manifest, the files and their sizes, the native-color identity, that a recolor stays inside the body mask, the ink and cream faces, face placement, and determinism.

## Agent avatars

The agent avatars in `assets/chickpea-avatars/agent-defaults/` are not built from the kit yet. Regenerated avatars need a new seed version, `chickpea-avatar-v2`, because Slack caches avatar images and swapping the image behind a `v1` seed would silently change live bots.
