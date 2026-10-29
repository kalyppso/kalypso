import { useStore } from "../store";
import { isDark } from "../appearance";
import logoLight from "../assets/logo-light.png";
import logoDark from "../assets/logo-dark.png";

// The mark is black, white and purple. On dark backgrounds its black figure
// would disappear, so dark themes use the reversed version (black drawn white).
export function Logo({ size = 26 }: { size?: number }) {
  const { state } = useStore();
  return <img src={isDark(state.appearance) ? logoDark : logoLight} width={size} height={size} alt="KALYPSO" style={{ display: "block", flex: "none", objectFit: "contain" }} />;
}
