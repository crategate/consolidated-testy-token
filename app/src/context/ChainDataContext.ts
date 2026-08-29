import { createContext } from 'react';
import type { ResolvedDeployment } from '../config';
import type {
    AmmStateData,
    LivePriceData,
    MarketStatusData,
    OfferListData,
    StakePoolData,
} from './chainDataHelpers';

export type RefreshKey = 'deployment' | 'marketStatus' | 'pool' | 'amm' | 'livePrice';

export interface ChainDataContextValue {
    deployment: ResolvedDeployment | null;
    deploymentLoading: boolean;
    marketStatus: MarketStatusData | null;
    marketStatusLoading: boolean;
    pool: StakePoolData | null;
    poolLoading: boolean;
    ammState: AmmStateData | null;
    ammStateLoading: boolean;
    offerList: OfferListData | null;
    offerListLoading: boolean;
    livePrice: LivePriceData;
    livePriceLoading: boolean;
    refresh: (key: RefreshKey) => Promise<void>;
}

export const ChainDataContext = createContext<ChainDataContextValue | null>(null);
