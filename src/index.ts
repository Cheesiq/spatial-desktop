import { VisibilityState, World } from '@iwsdk/core';
import { captureWindow, streamSource } from './capture.js';
import { buildEnvironment } from './environment.js';
import {
  addPanel,
  desktop,
  keyboardOwner,
  LAYOUTS,
  panelLabels,
  PanelSystem,
  releaseKeyboard,
  removePanel,
  setLayout,
} from './panels.js';
import { AdaptiveResolutionSystem, configureQuality, quality } from './quality.js';
import { Launcher, LauncherPlacementSystem, type LauncherTile } from './launcher.js';
import { AmbientMusic } from './music.js';
import { sfx, SfxListenerSystem } from './sfx.js';
import { connectVm } from './vm.js';
import { EmulatorMouseSystem } from './xr-mouse.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

World.create($('scene-container'), {
  xr: { offer: 'none' },
  render: { far: 200, camera: { position: [0, 1.6, 0.8], lookAt: [0, 1.45, -2.2] } },
  // Keep the mouse working after entering (emulated) VR, not just in 2D.
  input: { canvasPointerEvents: { enabled: true, activeDuringXR: true } },
  features: { grabbing: false, locomotion: false },
}).then((world) => {
  configureQuality(world.renderer);
  buildEnvironment(world);
  world.registerSystem(PanelSystem);
  world.registerSystem(EmulatorMouseSystem);
  world.registerSystem(AdaptiveResolutionSystem);
  world.registerSystem(LauncherPlacementSystem);
  world.registerSystem(SfxListenerSystem);

  // Dev-only handle for poking at the scene from DevTools and test scripts.
  if (import.meta.env.DEV) Object.assign(window, { spatial: { world, desktop, addPanel, streamSource, quality } });

  const list = $<HTMLUListElement>('panels');
  const layoutButton = $<HTMLButtonElement>('layout');
  const vmButton = $<HTMLButtonElement>('vm');
  const xrButton = $<HTMLButtonElement>('xr');
  const status = $<HTMLDivElement>('status');
  const meta = $<HTMLDivElement>('meta');
  const label = (button: HTMLElement, text: string) => {
    button.querySelector('.label')!.textContent = text;
  };
  // Render quality readout and shortcuts, refreshed once a second.
  const showPerf = () => {
    const mode = quality.tier === 'low' ? 'Low-end mode' : 'Quality: auto';
    meta.textContent = `${mode} · ${+quality.pixelRatio.toFixed(2)}× · ${quality.fps} fps  —  N window · V VM · L layout · M music · S sounds · A launcher · H hide · drag panels by their top bar`;
    meta.title = `GPU: ${quality.gpu}\nTier: ${quality.tier} (${quality.source}); override with ?quality=low or ?quality=high`;
  };
  setInterval(showPerf, 1000);
  showPerf();
  let message = '';
  // The 3D launcher dock, created further down once every action exists.
  let launcher: Launcher | null = null;

  const render = () => {
    label(layoutButton, desktop.layout[0].toUpperCase() + desktop.layout.slice(1));
    const owner = keyboardOwner();
    status.textContent = owner ? `Keyboard → ${owner} · click empty space to release` : message;
    status.classList.toggle('active', owner != null);
    launcher?.redraw();
    list.replaceChildren(
      ...panelLabels().map(([entity, label]) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = label;
        const close = document.createElement('button');
        close.className = 'state';
        close.innerHTML = '<svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        close.title = 'Remove panel';
        close.setAttribute('aria-label', `Remove ${label}`);
        close.onclick = () => removePanel(entity);
        item.append(name, close);
        return item;
      }),
    );
  };
  desktop.onChange = render;
  const say = (text: string) => {
    message = text;
    if (text) launcher?.toast(text);
    render();
  };

  const add = async () => {
    try {
      addPanel(world, await captureWindow());
    } catch (error) {
      // The user cancelled the portal picker; nothing to do.
      if ((error as DOMException).name !== 'NotAllowedError') console.error(error);
    }
  };

  let vmConnecting = false;
  const addVm = async () => {
    if (vmConnecting || panelLabels().some(([, label]) => label === 'Windows VM')) return;
    vmConnecting = true;
    say('Connecting to the Windows VM…');
    try {
      addPanel(world, await connectVm());
      say('');
    } catch (error) {
      sfx.play('error');
      say(`Windows VM: ${(error as Error).message}`);
    } finally {
      vmConnecting = false;
    }
  };

  // ---- ambient music ------------------------------------------------------
  // Settings survive reloads; storage can be unavailable, so never depend on it.
  const stored = (key: string) => {
    try {
      return localStorage.getItem(`spatial-desktop.${key}`);
    } catch {
      return null;
    }
  };
  const store = (key: string, value: string) => {
    try {
      localStorage.setItem(`spatial-desktop.${key}`, value);
    } catch {
      // Not persisted; fine.
    }
  };
  const audio = new AudioContext();
  const music = new AmbientMusic(audio, { lowEnd: quality.tier === 'low' });
  music.abundance = Number(stored('abundance') ?? 0.35);
  let musicOn = stored('music') !== 'off';
  sfx.attach(audio, { lowEnd: quality.tier === 'low' });
  sfx.enabled = stored('sfx') !== 'off';

  const musicButton = $<HTMLButtonElement>('music');
  const abundance = $<HTMLInputElement>('abundance');
  const abundanceValue = $<HTMLOutputElement>('abundance-value');
  abundance.value = String(music.abundance);
  const showMusic = () => {
    musicButton.classList.toggle('active', musicOn);
    musicButton.setAttribute('aria-pressed', String(musicOn));
    abundanceValue.textContent = music.abundance.toFixed(2);
    abundance.style.setProperty('--fill', `${music.abundance * 100}%`);
    launcher?.redraw();
  };
  const applyMusic = () => {
    if (musicOn) {
      void audio.resume();
      music.start();
    } else {
      music.stop();
    }
    showMusic();
  };
  const toggleMusic = () => {
    musicOn = !musicOn;
    store('music', musicOn ? 'on' : 'off');
    applyMusic();
    sfx.play(musicOn ? 'on' : 'off');
  };
  musicButton.onclick = toggleMusic;
  abundance.oninput = () => {
    music.abundance = Number(abundance.value);
    store('abundance', abundance.value);
    sfx.play('tick', { value: music.abundance });
    showMusic();
  };
  applyMusic();
  // Browsers may block audio until the first interaction; start then. UI
  // sounds need the context running even with the music off.
  const unlock = () => {
    if (audio.state !== 'running') void audio.resume();
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  if (import.meta.env.DEV) Object.assign(window, { music, audio });

  // ---- UI sounds -------------------------------------------------------------
  const soundsButton = $<HTMLButtonElement>('sounds');
  const showSounds = () => {
    soundsButton.classList.toggle('active', sfx.enabled);
    soundsButton.setAttribute('aria-pressed', String(sfx.enabled));
    launcher?.redraw();
  };
  const toggleSounds = () => {
    // Confirm with a sound either way: the last one on the way out.
    if (sfx.enabled) sfx.play('off');
    sfx.enabled = !sfx.enabled;
    if (sfx.enabled) sfx.play('on');
    store('sfx', sfx.enabled ? 'on' : 'off');
    showSounds();
  };
  soundsButton.onclick = toggleSounds;
  showSounds();
  if (import.meta.env.DEV) Object.assign(window, { sfx });

  // ---- hide/show controls ----------------------------------------------------
  const hud = $<HTMLDivElement>('hud');
  const setControlsHidden = (hidden: boolean) => {
    hud.classList.toggle('collapsed', hidden);
    store('controls', hidden ? 'hidden' : 'shown');
  };
  setControlsHidden(stored('controls') === 'hidden');
  const toggleControls = (hidden: boolean) => {
    setControlsHidden(hidden);
    sfx.play(hidden ? 'off' : 'on');
  };
  $('hide').onclick = () => toggleControls(true);
  $('show').onclick = () => toggleControls(false);

  const cycleLayout = () => {
    setLayout(LAYOUTS[(LAYOUTS.indexOf(desktop.layout) + 1) % LAYOUTS.length]);
    sfx.play('layout');
  };

  $('add').onclick = add;
  vmButton.onclick = addVm;
  layoutButton.onclick = cycleLayout;
  window.addEventListener('keydown', (event) => {
    // While the VM has the keyboard, keys belong to it, not to these shortcuts.
    if (keyboardOwner() || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === 'n') void add();
    if (event.key === 'v') void addVm();
    if (event.key === 'l') cycleLayout();
    if (event.key === 'm') toggleMusic();
    if (event.key === 's') toggleSounds();
    if (event.key === 'h') toggleControls(!hud.classList.contains('collapsed'));
  });

  const canvas = world.renderer.domElement;
  // Clicking the scene would otherwise move browser focus to <body> and take
  // the keyboard away from the VM right after the click gave it the keyboard.
  canvas.addEventListener('mousedown', (event) => event.preventDefault());
  // No browser context menu over the scene; right-click goes to the VM.
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  // Any click in the scene releases the keyboard first; a click on the VM's
  // screen takes it straight back (the panel's handler runs after this).
  window.addEventListener('pointerdown', (event) => event.target === canvas && releaseKeyboard(), true);
  // Keep the keyboard indicator honest when focus moves any other way.
  document.addEventListener('focusin', render);
  document.addEventListener('focusout', () => setTimeout(render));

  if (!world.xrEnabled) xrButton.style.display = 'none';
  xrButton.onclick = () =>
    world.visibilityState.peek() === VisibilityState.NonImmersive ? world.launchXR() : world.exitXR();
  let wasInVr = false;
  world.visibilityState.subscribe((state) => {
    const inVr = state !== VisibilityState.NonImmersive;
    if (inVr !== wasInVr) sfx.play(inVr ? 'enter' : 'exit');
    wasInVr = inVr;
    xrButton.classList.toggle('active', inVr);
    label(xrButton, inVr ? 'Exit VR' : 'VR');
    launcher?.redraw();
  });

  // ---- 3D launcher dock --------------------------------------------------------
  const ICONS = {
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    vm: 'M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z',
    layout: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    sounds: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    music: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
    less: 'M19 13H5v-2h14v2z',
    vr: 'M20.74 6H3.21C2.55 6 2 6.57 2 7.28v10.44c0 .7.55 1.28 1.23 1.28h4.79c.52 0 .96-.33 1.14-.79l1.4-3.48c.23-.59.79-1.01 1.44-1.01s1.21.42 1.45 1.01l1.39 3.48c.19.46.63.79 1.11.79h4.79c.71 0 1.26-.57 1.26-1.28V7.28c0-.7-.55-1.28-1.26-1.28zM7.5 14.62c-1.17 0-2.13-.95-2.13-2.12 0-1.17.96-2.13 2.13-2.13s2.12.96 2.12 2.13-.95 2.12-2.12 2.12zm9 0c-1.17 0-2.13-.95-2.13-2.12 0-1.17.96-2.13 2.13-2.13s2.12.96 2.12 2.13-.95 2.12-2.12 2.12z',
    terminal: 'M20 4H4c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.89-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z',
    browser: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
    files: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    editor: 'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
    activity: 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
  };
  const setAbundance = (value: number) => {
    music.abundance = Math.round(Math.min(1, Math.max(0, value)) * 20) / 20;
    abundance.value = String(music.abundance);
    store('abundance', abundance.value);
    sfx.play('tick', { value: music.abundance });
    showMusic();
  };
  const launchApp = async (id: string, name: string) => {
    say(`Opening ${name}…`);
    try {
      const response = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const result = (await response.json()) as { launched?: string; error?: string };
      if (!response.ok) sfx.play('error');
      say(response.ok ? `${result.launched} opened on your desktop · + Window to bring it in` : `${name}: ${result.error}`);
    } catch {
      sfx.play('error');
      say(`${name}: the launcher server isn't reachable`);
    }
  };
  let apps: Array<{ id: string; name: string }> = [];
  const controls = (): LauncherTile[] => [
    { id: 'add', label: 'Window', icon: ICONS.add, run: () => void add() },
    { id: 'vm', label: 'Windows VM', icon: ICONS.vm, run: () => void addVm() },
    { id: 'layout', label: desktop.layout[0].toUpperCase() + desktop.layout.slice(1), icon: ICONS.layout, run: cycleLayout },
    { id: 'music', label: 'Music', icon: ICONS.music, active: () => musicOn, run: toggleMusic },
    { id: 'sounds', label: 'Sounds', icon: ICONS.sounds, active: () => sfx.enabled, run: toggleSounds },
    { id: 'less', label: `p ${music.abundance.toFixed(2)} −`, icon: ICONS.less, run: () => setAbundance(music.abundance - 0.1) },
    { id: 'more', label: `p ${music.abundance.toFixed(2)} +`, icon: ICONS.add, run: () => setAbundance(music.abundance + 0.1) },
    ...(world.xrEnabled
      ? [{
          id: 'vr', label: world.visibilityState.peek() === VisibilityState.NonImmersive ? 'Enter VR' : 'Exit VR', icon: ICONS.vr,
          active: () => world.visibilityState.peek() !== VisibilityState.NonImmersive,
          run: () => (world.visibilityState.peek() === VisibilityState.NonImmersive ? world.launchXR() : world.exitXR()),
        }]
      : []),
  ];
  launcher = new Launcher(world, () => [
    { title: 'Controls', tiles: controls() },
    {
      title: 'Apps',
      tiles: apps.map((app) => ({
        id: app.id, label: app.name, icon: ICONS[app.id as keyof typeof ICONS] ?? ICONS.vm,
        run: () => void launchApp(app.id, app.name),
      })),
    },
  ]);
  world.getSystem(LauncherPlacementSystem)!.launcher = launcher;
  fetch('/api/apps')
    .then((response) => response.json() as Promise<typeof apps>)
    .then((list) => {
      apps = list;
      launcher?.redraw();
    })
    .catch(() => launcher?.toast('App list unavailable'));

  const launcherButton = $<HTMLButtonElement>('launcher');
  const setLauncherShown = (shown: boolean) => {
    launcher!.visible = shown;
    launcherButton.classList.toggle('active', shown);
    store('launcher', shown ? 'shown' : 'hidden');
  };
  setLauncherShown(stored('launcher') !== 'hidden');
  const toggleLauncher = () => {
    setLauncherShown(!launcher!.visible);
    sfx.play(launcher!.visible ? 'on' : 'off');
  };
  launcherButton.onclick = toggleLauncher;
  window.addEventListener('keydown', (event) => {
    if (keyboardOwner() || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === 'a') toggleLauncher();
  });
  if (import.meta.env.DEV) Object.assign(window, { launcher });

  // Material ripple from the press point on every button.
  document.addEventListener('pointerdown', (event) => {
    const button = (event.target as Element).closest?.('#hud button');
    if (!button) return;
    sfx.play('press');
    const host = (button.querySelector('.indicator') as HTMLElement | null) ?? (button as HTMLElement);
    const rect = host.getBoundingClientRect();
    const size = Math.hypot(rect.width, rect.height) * 2;
    const wave = document.createElement('span');
    wave.className = 'ripple-wave';
    Object.assign(wave.style, {
      width: `${size}px`, height: `${size}px`,
      left: `${event.clientX - rect.left - size / 2}px`, top: `${event.clientY - rect.top - size / 2}px`,
    });
    host.append(wave);
    wave.addEventListener('animationend', () => wave.remove());
  });

  render();
});
