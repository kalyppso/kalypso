import { useStore } from "../store";
import { isDark } from "../appearance";
import logoLightLg from "../assets/logo-light-lg.svg";
import logoDarkLg from "../assets/logo-dark-lg.svg";

// The mark: Kalypso as a wireframe, the same drawing the website and README use (SVG), in the
// theme's line colour. Always the fine line, a little dimmed, so it never shouts next to text.
export function Logo({ size = 26 }: { size?: number; fine?: boolean }) {
  const { state } = useStore();
  const dark = isDark(state.appearance);
  return <img src={dark ? logoDarkLg : logoLightLg} width={size} height={size} alt="KALYPSO" style={{ display: "block", flex: "none", objectFit: "contain", opacity: 0.72 }} />;
}
