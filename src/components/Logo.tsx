import { useStore } from "../store";
import { isDark } from "../appearance";
import logoLight from "../assets/logo-light.png";
import logoDark from "../assets/logo-dark.png";

// The mark is Kalypso drawn in fine line, on a transparent ground. Dark themes
// use her in white line, light themes in ink.
export function Logo({ size = 26 }: { size?: number }) {
  const { state } = useStore();
  return <img src={isDark(state.appearance) ? logoDark : logoLight} width={size} height={size} alt="KALYPSO" style={{ display: "block", flex: "none", objectFit: "contain" }} />;
}
