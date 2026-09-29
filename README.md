<div align="center">

# Spatial Desktop

**Your Hyprland desktop, your apps and your Windows VM — floating as panels in a living, deep-space neural interface.**

Built for [Omarchy](https://omarchy.org) on Hyprland with Meta's [Immersive Web SDK](https://github.com/facebook/immersive-web-sdk). Runs in a browser window on your desktop, and in WebXR.

<img src="docs/images/hero.jpg" alt="Three panels in an arc — a terminal running fastfetch, Hyprland itself, and Neovim — in front of a glowing neural core, with the control bar below" width="100%">

### [⬇ Download](https://cheesiq.github.io/spatial-desktop/) · [Open in your browser](https://cheesiq.github.io/spatial-desktop/app/) · [Releases](https://github.com/Cheesiq/spatial-desktop/releases)

</div>

---

## What it does

- **Hyprland itself as a panel.** A virtual Hyprland monitor streamed into the scene, as a real part of your desktop. Click it and your real mouse and keyboard move inside: hover, drag, type, use Super shortcuts. Apps open on it, and windows move between it and your real monitors.
- **Search from anywhere.** Press <kbd>/</kbd> to open Omarchy's app search on the Hyprland panel.
- **Any window as a panel.** Add windows, regions or whole monitors through Hyprland's screen-share picker.
- **Your Windows VM, fully controllable.** Omarchy's Windows VM streams in over VNC, with mouse and keyboard passed through.
- **Arrange your space.** Arc, grid and stack layouts. Drag panels by their frame, and tap one to bring it up close.
- **A 3D launcher dock** for controls and apps, usable with the mouse or XR controllers.
- **A deep-space neural interface** to work in: a nebula sky, a living neural core, a network of firing neurons and a holographic platform.
- **Ambient generative music and spatial UI sounds**, both optional.
- **Adapts to your GPU.** It lowers render resolution automatically to hold frame rate, and has a lighter mode for integrated GPUs.

---

## Screenshots

### Hyprland, inside the scene

Tap a panel to bring it up close. Here the Hyprland panel shows the virtual monitor, with a terminal and Neovim open on it.

<img src="docs/images/hyprland-panel.jpg" alt="The Hyprland panel up close, showing a terminal with fastfetch and Neovim side by side" width="100%">

Press <kbd>/</kbd> (or the **Search** tile) and Omarchy's **Search or ask** menu opens right on the panel. Apps you launch from it open there too.

<img src="docs/images/hyprland-search.jpg" alt="Omarchy's Search or ask app menu open on the Hyprland panel" width="100%">

### Layouts

Cycle layouts with <kbd>L</kbd>. Drag any panel by its frame to place it yourself.

| Arc | Grid | Stack |
| :-: | :-: | :-: |
| <img src="docs/images/layout-arc.jpg" alt="Arc layout"> | <img src="docs/images/layout-grid.jpg" alt="Grid layout"> | <img src="docs/images/layout-stack.jpg" alt="Stack layout"> |

### Launcher dock

A dock floating in the scene, below the panels in 2D and within reach in VR. **Controls** add panels and toggle things. **Apps** launch programs, onto the Hyprland panel when it's open.

<img src="docs/images/launcher.jpg" alt="The 3D launcher dock with Controls and Apps rows" width="100%">

### The neural interface

Everything in the scene is generated in code and animated in shaders. There are no image assets, and it takes only a handful of draw calls.

<img src="docs/images/scene.jpg" alt="The empty scene: the neural core above the platform, among neuron clusters" width="100%">

| The neural core | The network |
| :-: | :-: |
| <img src="docs/images/neural-core.jpg" alt="Close-up of the neural core: an orb of glowing filaments ringed by dashed interface rings"> | <img src="docs/images/neural-network.jpg" alt="Clusters of neurons joined by synapses in front of a blue and violet nebula"> |
| Filaments with waves of activity, an atmosphere and sweeping interface rings. | Neuron clusters wired by curved synapses. Signal pulses travel along them, and neurons flash as they fire. |

<img src="docs/images/platform.jpg" alt="Looking down at the holographic platform: rings and spokes fading into space, with a violet ring at the viewer's feet" width="100%">

<sub>The holographic platform underfoot. Pulses ripple outward and a radar sweep lights up the grid.</sub>

### Controls

<img src="docs/images/hud.jpg" alt="The bottom control bar with panel chips, shortcuts, destinations and the music abundance slider" width="100%">

<sub>Screenshots were captured in a headless browser with a software renderer, which is why the bar reads 15 fps. On a real GPU it runs at your display's refresh rate.</sub>

---

## Download

Get it from the **[download page](https://cheesiq.github.io/spatial-desktop/)**, or straight from the [latest release](https://github.com/Cheesiq/spatial-desktop/releases/latest):

| Platform | Download | Notes |
| --- | --- | --- |
| **Linux** | [AppImage](https://github.com/Cheesiq/spatial-desktop/releases/latest/download/Spatial-Desktop-linux-x86_64.AppImage) · [.deb](https://github.com/Cheesiq/spatial-desktop/releases/latest/download/Spatial-Desktop-linux-amd64.deb) | Every feature on Hyprland (Omarchy). `chmod +x` the AppImage and run it. |
| **Windows 10/11** | [Installer](https://github.com/Cheesiq/spatial-desktop/releases/latest/download/Spatial-Desktop-win-x64-setup.exe) | Not code-signed yet: *More info → Run anyway*. |
| **macOS 12+** | [Disk image](https://github.com/Cheesiq/spatial-desktop/releases/latest/download/Spatial-Desktop-mac-universal.dmg) | Universal. Not notarized yet: *right-click → Open* the first time. |
| **Android 7+ / Meta Quest** | [APK](https://github.com/Cheesiq/spatial-desktop/releases/latest/download/Spatial-Desktop-android.apk) | Offline app. On Quest, sideload it (it runs as a 2D window). |
| **Web / VR headsets** | [Open in your browser](https://cheesiq.github.io/spatial-desktop/app/) | Nothing to install. Real VR in the Quest Browser and other WebXR browsers. |

Every build contains the whole scene. The desktop features — the Hyprland panel, the Windows VM and launching apps into the scene — need Linux with Hyprland. Everywhere else, the app offers only what the device supports (window panels where the OS allows screen capture, VR where a WebXR headset is available).

The rest of this README covers running from source, which is how you develop it.

## Requirements

| | |
| --- | --- |
| **Desktop** | [Omarchy](https://omarchy.org) on **Hyprland 0.56+** (the Lua config API). Other Hyprland setups work for most features. |
| **Browser** | **Chromium**, run as a native Wayland app by `bin/spatial-desktop` so screen capture goes through PipeWire. |
| **Node.js** | **20.19+ or 22.12+** (Vite 7's requirement), and npm. |
| **Hyprland panel** | [`wayvnc`](https://github.com/any1/wayvnc) (`sudo pacman -S wayvnc`). |
| **Window capture** | `xdg-desktop-portal-hyprland` (included with Omarchy). |
| **Windows VM** *(optional)* | Omarchy's Windows VM: `omarchy-windows-vm install`. |
| **macOS VM** *(optional)* | `bin/macos-vm install` ([dockur/macos](https://github.com/dockur/macos) in Docker, needs KVM). |
| **VR** *(optional)* | A WebXR headset. Without one, a Quest 3 emulator runs on your desktop. |

## Install

```bash
# 1. Get the code
git clone https://github.com/Cheesiq/spatial-desktop.git
cd spatial-desktop

# 2. Install dependencies
npm install

# 3. For the Hyprland panel
sudo pacman -S --needed wayvnc
```

## Run

Start the dev server, which also runs the VM proxy, the app launcher and the Hyprland panel:

```bash
npm run dev
```

Then, in another terminal, open it as a native-Wayland Chromium app window:

```bash
npm run open            # or: bin/spatial-desktop
```

It opens at `http://localhost:5173` in its own Chromium profile, separate from your everyday browser.

To run the production build instead of the dev server:

```bash
npm run build && npm start      # http://127.0.0.1:5174
npm run desktop                 # the desktop app (Electron), from source
```

> [!TIP]
> Bind it to a key in `~/.config/hypr/bindings.lua` to open it like any other app:
> ```lua
> o.bind("SUPER + SHIFT + X", "Spatial Desktop", "~/path/to/spatial-desktop/bin/spatial-desktop")
> ```

## Using it

### Keyboard shortcuts

| Key | Action |
| :-: | --- |
| <kbd>D</kbd> | Add the **Hyprland** panel |
| <kbd>/</kbd> | **Search** apps on the Hyprland panel |
| <kbd>N</kbd> | Add a **window**, region or monitor (opens the share picker) |
| <kbd>V</kbd> | Add the **Windows VM** |
| <kbd>O</kbd> | Add the **macOS VM** |
| <kbd>L</kbd> | Cycle **layout**: arc → grid → stack |
| <kbd>A</kbd> | Show or hide the **launcher** dock |
| <kbd>M</kbd> | Toggle **music** |
| <kbd>S</kbd> | Toggle **UI sounds** |
| <kbd>H</kbd> | Hide or show the **control bar** |

Shortcuts pause while a panel has the keyboard.

### Panels

- **Move** a panel by dragging its frame or top bar.
- **Tap** a panel's frame to bring it up close, and tap again to send it back.
- **Remove** a panel with the × on its chip in the control bar.

### The Hyprland panel

Hyprland has one cursor and one keyboard focus, and it shares them with the Spatial Desktop window. So the Hyprland panel works like a portal:

1. **Click** anywhere on the Hyprland panel. Your real cursor and keyboard move onto the virtual monitor, and that click lands where you clicked.
2. **Use it natively.** Hover, drag, type and Super shortcuts all work, and you see the cursor in the panel.
3. **Push the cursor off the left, right or bottom edge** to come back into the scene, next to the panel. The top edge is left alone because the bar lives there.

With **XR controllers**, clicks go through without moving your cursor. Keys you type go to the window you last clicked.

The virtual monitor is `SPATIAL-1`, with its own `spatial` workspace. It sits away from your real monitors, so your mouse can never wander onto it by accident. When the dev server stops, the monitor is removed and any windows on it move to your real screen.

### The Windows VM

Install and start Omarchy's Windows VM (`omarchy-windows-vm install`, then `launch`), then press <kbd>V</kbd>. The dev server reads the VM's login from `~/.config/windows/credentials` and adds it server-side, so the password never reaches the page. Click the VM's screen to give it the keyboard, and click empty space to take it back.

### The macOS VM

`bin/macos-vm install` sets up macOS 15 in Docker; pass another version number to choose it, and set `RAM_SIZE`, `CPU_CORES` or `DISK_SIZE` to change the defaults (6G, 4, 64G). Then `bin/macos-vm launch` starts it and opens its web viewer on `http://127.0.0.1:8007`. The first boot downloads macOS Recovery from Apple: in Disk Utility, erase the largest disk as APFS, then choose Reinstall macOS. After that, press <kbd>O</kbd>. It works like the Windows VM: the login comes from `~/.config/macos/credentials` and is added server-side. `bin/macos-vm stop` shuts it down. Apple's license only allows macOS on Apple hardware.

### VR

Click **VR** (or **Enter VR** on the launcher). With no headset attached, an emulated Quest 3 runs in the page. On a real headset, the page must be served from `localhost`. For a Quest over USB, `adb reverse tcp:5173 tcp:5173` then open `http://localhost:5173` in the headset's browser.

### Quality

The scene picks a quality tier from your GPU, and the control bar shows the current tier, resolution and frame rate. Force a tier with a URL parameter:

- `http://localhost:5173/?quality=low` for integrated GPUs: a smaller sky, fewer neurons, no mipmaps.
- `http://localhost:5173/?quality=high`

Either way, the render resolution adapts between 0.75× and 2× to hold about 60 fps.

---

## How it works

```
┌──────────────── Chromium (native Wayland) ────────────────┐
│  IWSDK / three.js scene                                    │
│   ├─ panels  ← portal capture (PipeWire)  ─ windows        │
│   ├─ panels  ← noVNC ── /vm-vnc, /macos-vnc ┐              │
│   ├─ panels  ← noVNC ── /hyprland-vnc ──┐   │              │
│   └─ launcher, environment, audio       │   │              │
└─────────────────────────────────────────┼───┼──────────────┘
                   Vite dev server        │   │
   ├─ /hyprland-vnc  websocket ⇄ unix socket ─ wayvnc ─ SPATIAL-1 (headless Hyprland output)
   ├─ /api/hyprland/*  cursor, focus, keys via Hyprland IPC
   ├─ /vm-vnc, /macos-vnc  websocket ⇄ each VM's noVNC (+ credentials)
   └─ /api/apps, /api/launch  fixed allow-list of launchers
```

- **Security.** Every endpoint and websocket only accepts this app's own origin, so other sites open in your browser can't drive your desktop through `localhost`. `wayvnc` listens on a private unix socket, never on the network. The launcher can only start the fixed programs listed in `server/apps.ts`.
- **Hyprland input.** Hyprland maps `wayvnc`'s absolute pointer onto the first real monitor, so the server positions the cursor through Hyprland IPC, and VNC only carries buttons and the wheel.
- **Rendering.** The nebula is baked once into a half-float cube map at startup, and everything else animates in shaders. VNC panels upload only the regions that changed.

### Project layout

| Path | What's there |
| --- | --- |
| `src/index.ts` | App wiring: control bar, shortcuts, launcher tiles |
| `src/panels.ts` | Panels: layouts, dragging, focus, input routing |
| `src/hyprland.ts` · `server/hyprland.ts` | The Hyprland panel (page side and server side) |
| `src/vnc.ts` · `src/vm.ts` | noVNC plumbing, and the Windows and macOS VMs |
| `src/capture.ts` | Window capture through the desktop portal |
| `src/environment.ts` | The neural interface scene |
| `src/launcher.ts` | The 3D launcher dock |
| `src/music.ts` · `src/sfx.ts` | Generative ambient music and UI sounds |
| `src/quality.ts` | GPU tiering and adaptive resolution |
| `src/capabilities.ts` · `server/features.ts` | Which features this install has, and the server side of each |
| `server/main.ts` | The production server (used by the desktop app and `npm start`) |
| `server/apps.ts` | The launcher's app allow-list |
| `vite.config.ts` | The dev server, mounting the same features |
| `electron/` · `electron-builder.yml` | The desktop app and its packaging |
| `android/` · `capacitor.config.json` | The Android app (Capacitor) |
| `site/` | The download and releases page (GitHub Pages) |
| `.github/workflows/` | Release builds for every platform, and the Pages deploy |
| `scripts/` | End-to-end tests over the Chrome DevTools Protocol |

### Development

```bash
npm run typecheck      # tsc
npm run build          # typecheck, web build (dist/) and server bundle (dist-server/)
npm run dist:desktop   # desktop packages for this OS, in release/
npm run dist:android   # unsigned APK (needs JDK 21 and the Android SDK)

# End-to-end tests drive a separate headless Chromium over CDP:
chromium --headless=new --remote-debugging-port=9224 --user-data-dir=/tmp/sd-test http://localhost:5173 &
CDP_PORT=9224 node scripts/launcher-test.mjs /tmp
CDP_PORT=9224 node scripts/hyprland-test.mjs /tmp   # moves your real cursor for a moment
```

---

### Releasing

Push a version tag and GitHub Actions builds every platform and publishes the release; the download page picks it up automatically:

```bash
npm version 1.1.0 --no-git-tag-version && git commit -am "Release 1.1.0"
git tag v1.1.0 && git push origin main v1.1.0
```

APKs are signed with the key in the `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` secrets. Keep a backup of that key: an app signed with a different key can't update an existing install.

---

## Troubleshooting

<details>
<summary><b>"wayvnc is not installed"</b> when adding the Hyprland panel</summary>

Install it with `sudo pacman -S wayvnc`, then try again. You don't need to restart anything.
</details>

<details>
<summary><b>The Hyprland panel or search does nothing</b></summary>

The dev server has to run inside your Hyprland session, because it needs `HYPRLAND_INSTANCE_SIGNATURE`. Start `npm run dev` from a terminal on your desktop, not over SSH or from a system service.
</details>

<details>
<summary><b>My cursor is on the Hyprland panel and I can't get back</b></summary>

Push it off the panel's **left, right or bottom** edge. Switching to a workspace on a real monitor (<kbd>Super</kbd>+<kbd>1</kbd>…) also brings it back, and so does closing the Spatial Desktop page.
</details>

<details>
<summary><b>Adding a window shows no picker, or a black panel</b></summary>

Open Spatial Desktop with `bin/spatial-desktop`. It runs Chromium as a native Wayland client with PipeWire capture enabled, which the portal needs. An ordinary X11 Chromium window can't capture Hyprland windows.
</details>

<details>
<summary><b>Windows VM: "Could not reach the VM display"</b></summary>

Start the VM (`omarchy-windows-vm launch`) and check that its web viewer answers on `http://127.0.0.1:8006`. For the macOS VM, run `bin/macos-vm launch` and check `http://127.0.0.1:8007`.
</details>

<details>
<summary><b>Windows VM won't start after it has run once</b></summary>

The VM container marks `~/Windows` setgid on every start, and `omarchy-windows-vm` then refuses the next start without saying why, because it expects that folder's permissions to be exactly `700`. Run `chmod g-s ~/Windows`, then launch again.
</details>

<details>
<summary><b>Low frame rate</b></summary>

Try `?quality=low`. The GPU readout is in the tooltip on the quality line in the control bar. If it says SwiftShader or llvmpipe, Chromium is rendering on the CPU; check `chrome://gpu`.
</details>
