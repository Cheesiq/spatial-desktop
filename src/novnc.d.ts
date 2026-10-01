// Minimal typings for the parts of noVNC's public RFB API this app uses.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: { shared?: boolean; credentials?: { username?: string; password?: string }; wsProtocols?: string[] },
    );
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    viewOnly: boolean;
    focus(options?: FocusOptions): void;
    blur(): void;
    disconnect(): void;
    sendCtrlAltDel(): void;
    /** Send one key event: an X11 keysym and a KeyboardEvent.code (for servers that take scancodes). */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
  }
}
