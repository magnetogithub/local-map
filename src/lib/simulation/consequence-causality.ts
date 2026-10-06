import type {ScheduledConsequenceV1} from './narrative-state';

/** Only pending/due consequences may cause an event, on or after their own earliest date. */
export function isConsequenceAvailableAt(consequence:Pick<ScheduledConsequenceV1,'earliestDate'|'status'>,eventDate:string){
  return (consequence.status==='scheduled'||consequence.status==='due')&&consequence.earliestDate<=eventDate;
}
