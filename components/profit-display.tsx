import { useState } from "react";

import { LoadingSummary } from "./loading-summary";
import { ProfitSummary } from "./profit-summary";
import {
  defaultEnd,
  defaultStart,
  QuoteTokenSummaryFilter,
} from "./quote-token-summary-filter";

import { MeteoraPosition } from "@/services/MeteoraPosition";
import { PositionLoadingState } from "@/pages/wallet/[walletAddress]";

export const ProfitDisplay = (props: {
  loading: boolean;
  positionLoadingState: PositionLoadingState;
}) => {
  const [initialized, setInitialized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [filteredPositions, setFilteredPositions] = useState(
    props.positionLoadingState.positions,
  );
  const [dates, setDates] = useState({
    start: defaultStart,
    end: defaultEnd,
  });
  const [usd, setUsd] = useState(false);

  if (props.positionLoadingState.startTime == 0) {
    return <></>;
  }

  if (!props.loading && !initialized) {
    setInitialized(true);
    setFilteredPositions(props.positionLoadingState.positions);
  }

  function filterPositions(data: {
    dates: {
      start: number;
      end: number;
    };
    positions: MeteoraPosition[];
  }) {
    setDates(data.dates);
    setFilteredPositions(data.positions);
  }

  return (
    <div>
      <div className="w-full">
        <LoadingSummary
          filteredPositions={filteredPositions}
          loading={props.loading}
          positionLoadingState={props.positionLoadingState}
          usd={usd}
        />
        <QuoteTokenSummaryFilter
          dates={dates}
          expanded={expanded}
          hidden={props.positionLoadingState.positions.length == 0}
          positionLoadingState={props.positionLoadingState}
          usd={usd}
          onExpandToggle={(expanded) => setExpanded(expanded)}
          onFilter={(data) => filterPositions(data)}
          onUsdToggle={() => setUsd(!usd)}
        />
        <ProfitSummary
          hidden={props.positionLoadingState.positions.length == 0}
          positions={filteredPositions}
          tokenMap={props.positionLoadingState.tokenMap}
          usd={usd}
        />
      </div>
    </div>
  );
};
