const GUIDE_KEY = "futuretransit:guide-dismissed:v1";
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
