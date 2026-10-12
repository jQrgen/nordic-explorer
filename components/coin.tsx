import type { ChainId } from "@/lib/types";
import { chains } from "@/lib/data";

const LOGOS: Record<ChainId, string> = { nexa: "/brand/nexa.svg", bch: "/brand/bch.svg" };

/** Official coin mark, sized to the surrounding text (about 1em). */
export function CoinLogo({ chain }: { chain: ChainId }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="coin-logo" src={LOGOS[chain]} alt={`${chains[chain].name} logo`} width={16} height={16} />;
}

/** Chain name with its logo in front, e.g. in headings, crumbs and eyebrows. */
export function ChainName({ chain }: { chain: ChainId }) {
  return (
    <span className="coin">
      <CoinLogo chain={chain} />
      {chains[chain].name}
    </span>
  );
}
