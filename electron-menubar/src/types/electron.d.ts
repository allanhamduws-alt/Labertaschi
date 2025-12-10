export {};

declare global {
  interface Window {
    electronAPI?: {
      onHotkeyToggle: (cb: () => void) => void;
      sendOutput: (text: string, opts: { autopaste: boolean }) => void;
      copyText: (text: string) => void;
    };
  }
}
