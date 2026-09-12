const GUIDE_KEY = "futuretransit:guide-dismissed:v1";
const INTRO_KEY = "futuretransit:intro-seen:v1";

export function readIntroSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === "true";
  } catch {
    return false;
  }
}

export function rememberIntroSeen(): void {
  try {
    localStorage.setItem(INTRO_KEY, "true");
  } catch {
    /* The introduction remains dismissible when storage is unavailable. */
  }
}

export function readGuideDismissed(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === "true";
  } catch {
    return false;
  }
}
export function rememberGuideDismissed(value: boolean): void {
  try {
    localStorage.setItem(GUIDE_KEY, String(value));
  } catch {
    /* Tutorial preferences are optional; gameplay remains usable. */
  }
}
