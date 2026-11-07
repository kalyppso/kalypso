import { useStore } from "../store";
import { isDark } from "../appearance";
import logoLight from "../assets/logo-light.svg";
import logoDark from "../assets/logo-dark.svg";
import logoLightLg from "../assets/logo-light-lg.svg";
import logoDarkLg from "../assets/logo-dark-lg.svg";

// The mark: Kalypso as a wireframe, the same drawing the website and README use (SVG). Dark
// themes use her in white line, light themes in ink. Small sizes use a bolder line so she still
// reads; larger ones the fine line.
export function Logo({ size = 26 }: { size?: number }) {
  const { state } = useStore();
  const dark = isDark(state.appearance);
  const src = size >= 56 ? (dark ? logoDarkLg : logoLightLg) : dark ? logoDark : logoLight;
  return <img src={src} width={size} height={size} alt="KALYPSO" style={{ display: "block", flex: "none", objectFit: "contain" }} />;
}
