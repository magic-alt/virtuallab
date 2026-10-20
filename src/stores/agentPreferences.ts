import { create } from 'zustand';

interface AgentPreferences {
  codexExecutablePath: string;
  setCodexExecutablePath: (path: string) => void;
}

const CODEX_EXECUTABLE_KEY = 'virtuallab-codex-executable-v1';

function savedExecutablePath(): string {
  try { return window.localStorage.getItem(CODEX_EXECUTABLE_KEY) ?? ''; }
  catch { return ''; }
}

/** Keep the original raw preference compatible with existing installations. */
export const useAgentPreferences = create<AgentPreferences>()(set => ({
  codexExecutablePath: savedExecutablePath(),
  setCodexExecutablePath: path => {
    // This is also controlled-input state: trimming each keystroke would erase
    // spaces while the user types a launcher path. Consumers normalize on use.
    const codexExecutablePath = path;
    try {
      if (codexExecutablePath) window.localStorage.setItem(CODEX_EXECUTABLE_KEY, codexExecutablePath);
      else window.localStorage.removeItem(CODEX_EXECUTABLE_KEY);
    } catch { /* The current application can still use the selected launcher. */ }
    set({ codexExecutablePath });
  },
}));
