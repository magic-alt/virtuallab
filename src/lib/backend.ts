import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { RepositorySnapshot } from "@/types/workbench";

export function isDesktopRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export async function chooseRepositoryDirectory(): Promise<string | null> {
  if (!isDesktopRuntime()) {
    throw new Error("Folder selection is available in the Tauri desktop runtime.");
  }

  const selected = await open({
    directory: true,
    multiple: false,
    title: "Add Git repository",
  });

  return typeof selected === "string" ? selected : null;
}

export async function inspectRepository(path: string): Promise<RepositorySnapshot> {
  if (!isDesktopRuntime()) {
    throw new Error("Native Git inspection is available in the Tauri desktop runtime.");
  }

  return invoke<RepositorySnapshot>("inspect_repository", { path });
}
