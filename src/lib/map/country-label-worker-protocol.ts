import type {CountryLabelLayout,CountryLabelLayoutInput} from "./country-label-layout";

export type CountryLabelWorkerRequest={
  type:"recompute-country-labels";
  requestId:string;
  changedCountries:CountryLabelLayoutInput[];
  previousLayouts:Record<string,CountryLabelLayout>;
};

export type CountryLabelWorkerResponse=
  |{type:"country-labels-recomputed";requestId:string;layouts:CountryLabelLayout[]}
  |{type:"country-label-error";requestId:string;message:string};
