import {FetchOpenAIResponsesTransport} from './openai-responses-transport';
import {OpenAIResponsesSimulationProvider} from './openai-responses-provider';
import {loadSimulationProviderConfig} from './provider-config';
export function createProductionSimulationProvider(){const config=loadSimulationProviderConfig();return new OpenAIResponsesSimulationProvider(config,new FetchOpenAIResponsesTransport(config.apiKey));}
