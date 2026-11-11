import "server-only";

import { layoffsForCompany, type CompanyLayoffsView } from "./layoffs";
import { marketSalaryForRole, offerVsMarket, type MarketSalary } from "./salary-market";
import { currencyForCountry } from "./salary-sources";
import { offerSalaryOf, type ParsedSalary } from "./salary";

export type PostingIntel = {
  offer: ParsedSalary | null;
  offerLabel: string;
  market: MarketSalary | null;
  marketLabel: string;
  comparison: string | null;
  layoffs: CompanyLayoffsView;
};

/** Offer salary, market band (config/salary-sources.json), and company layoffs. */
export async function loadPostingIntel(input: {
  company: string;
  title: string;
  place?: string;
  country?: string;
  salary?: string;
  description?: string;
}): Promise<PostingIntel> {
  const country = (input.country ?? "").trim().toLowerCase();
  const currencyHint = country ? currencyForCountry(country) : "";
  const offer = offerSalaryOf(
    { salary: input.salary, title: input.title, description: input.description },
    currencyHint,
  );

  const [market, layoffs] = await Promise.all([
    country
      ? marketSalaryForRole({ title: input.title, place: input.place, country })
      : Promise.resolve(null),
    layoffsForCompany(input.company, input.title),
  ]);

  return {
    offer,
    offerLabel: offer?.label ?? (input.salary?.trim() || "Not listed"),
    market,
    marketLabel: market?.label ?? "No market data",
    comparison: offerVsMarket(offer, market),
    layoffs,
  };
}
