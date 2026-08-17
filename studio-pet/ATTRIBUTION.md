# Desktop Pet Attribution

## Open-source shell

The `studio-pet/` desktop pet shell is adapted from **pixelpets** (MIT License):

- Repository: https://github.com/JOhnsonKC201/pixelpets
- License: MIT (copy at the end of this file)
- Upstream description: *A pixel cat or dog that lives on your desktop*

Why it was chosen: the upstream project is a mature pixel-cat implementation (14 coats, including calico), with a full-screen transparent overlay, click-through, cursor tracking, hover detection, speech bubbles, and many animations (sit/typing/pounce/butterfly/yarn). It looks far friendlier than a plain glowing orb and supports macOS directly.

## What we kept

- Full-screen transparent, frameless, always-on-top click-through overlay (`setIgnoreMouseEvents` + hot bounding box)
- Pixel-cat sprite and all 14 coats (default black-and-white Tuxedo)
- Dragging, petting, mood/energy model, and the cat's own animations
- Upstream low-power mode: lower frame rate, slower polling, high-cost animations off; auto-enable on battery
- Synthesized sounds (meow/chirp/purr, `audio.js`)
- Tray and right-click menus (continuous size / coat / low-power / always-on-top / open / quit)

## What we stripped

- **Dog** (`dog-sprite.js`, dog branch in `pets.js`): cats only
- **Settings window** (`settings*.html/js`): all settings moved into tray/right-click menus
- **Mail** (`mail*.js`), **calendar** (`cal*.js`), **pomodoro/reminders/break** timers
- **Lobby Jam music** (`jam.js`) and autoplay switches
- **Custom coat editor** (`themes.js`, `themes.json`)
- **Notification bridge files** (`pixelcat-agent.state` / `pixelcat-notify.jsonl`): replaced with direct HTTP polling of AgentFlow Studio
- **Global keyboard hook** (`uiohook-napi`): no longer needs macOS accessibility permission
- **Autostart** and `--autostart`

## What we added/changed

- **AgentFlow status bridge**: the main process polls `http://127.0.0.1:4870/api/flows` every 1.8s (falls back to a free local port; auto-starts Studio when it is not running) and maps `idle / working / done / error` to cat reactions
- **No mouse chasing**: cursor coordinates are not fed into the behavior layer; following, hunting, startle, roaming, and butterfly are off
- **Touch interaction**: hovering the cat only plays the built-in touch/happy animation; no status, buttons, or links appear
- **Click/drag separation**: press-release under 220ms with under 6px of movement counts as a click and opens AgentFlow; anything beyond that is a drag that only moves the pet and never opens a window
- **Continuous size**: right-click opens a size slider from `0.2x` to `3.0x` in `0.01x` steps; all main poses and hit areas update at the same scale
- **Size regression check**: `npm run test:pet-size` captures isolated Electron screenshots across `0.2x–3.0x` for the main poses; it discovers a local Electron, `ELECTRON_BIN`, or one on `PATH`, and runs on macOS, Windows, and Linux
- **Three-platform launchers**: `run-pet.sh` (macOS/Linux), `run-pet.ps1` and `run-pet.cmd` (Windows); first launch can install the pinned Electron, or `AF_ELECTRON` can point to a managed runtime
- **Menu cleanup**: size, coat, play area, low-power, always-on-top, language, open, quit. The "rest corner" button was removed as it had no practical value; an existing `restSide` setting is still honored internally

## MIT License (pixelpets)

```
MIT License

Copyright (c) 2026 JOhnsonKC201

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
