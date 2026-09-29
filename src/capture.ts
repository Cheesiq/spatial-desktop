import { LinearFilter, SRGBColorSpace, VideoTexture } from '@iwsdk/core';
import { quality } from './quality.js';
import type { PanelSource } from './source.js';

/**
 * Ask the desktop portal for a window, region, or monitor. On Hyprland this
 * opens xdg-desktop-portal-hyprland's picker; the browser must run as a native
 * Wayland client with PipeWire capture (see bin/spatial-desktop).
 */
export async function captureWindow(): Promise<PanelSource> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 60 } },
    audio: false,
  });
  return streamSource(stream);
}

/** A view-only panel source backed by a video MediaStream. */
export function streamSource(stream: MediaStream, label?: string): PanelSource {
  const track = stream.getVideoTracks()[0];
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  void video.play();

  // three.js only re-uploads a VideoTexture when the video has a new frame.
  const texture = new VideoTexture(video);
  texture.colorSpace = SRGBColorSpace;
  if (!quality.mipmaps) {
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
  }

  return {
    label: label ?? (track?.label || 'Window'),
    texture,
    size: () => (video.videoWidth && video.videoHeight ? [video.videoWidth, video.videoHeight] : null),
    // Stopping the share from the portal ends the track.
    onEnded: (callback) => track?.addEventListener('ended', callback),
    dispose: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      texture.dispose();
    },
  };
}
