/** User preference for the decorative 3D scenes (Settings → Appearance). On by default. */
const KEY = "wt_pref_3d";

export const is3DEnabled = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
};

export const set3DEnabled = (on: boolean) => {
  try {
    localStorage.setItem(KEY, String(on));
  } catch {
    /* storage unavailable */
  }
};
