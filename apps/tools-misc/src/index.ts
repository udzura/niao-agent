import {WorkerEntrypoint} from "cloudflare:workers";
import {WebFetchAsyncService, type BrowserWebFetchSettings} from "./web-fetch-async";
import {WebFetchService} from "./web-fetch";
import type {WebFetchInput} from "./contracts";
import {WeatherService} from "./weather";
import type {LocationInput, ForecastInput} from "./contracts";
import {KaniService} from "./kani";
import {z} from "zod";
import {kaniArticleInput,kaniLatestInput,kaniSearchInput} from "./contracts";
export default class ToolsMisc extends WorkerEntrypoint<BrowserWebFetchSettings> {
  async webFetchAsync(request: WebFetchInput) { return new WebFetchAsyncService(this.env).get(request); }
  async webFetch(request: WebFetchInput) { return new WebFetchService(this.env).get(request); }
  async searchWeatherLocations(request: LocationInput) { return new WeatherService().search(request); }
  async getWeatherForecast(request: ForecastInput) { return new WeatherService().getForecast(request); }
  async getKaniArticle(request: z.input<typeof kaniArticleInput>) { return new KaniService().article(request); }
  async getLatestKaniArticle(request: z.input<typeof kaniLatestInput>) { return new KaniService().latest(request); }
  async searchKaniArticles(request: z.input<typeof kaniSearchInput>) { return new KaniService().search(request); }
  async fetch() { return new Response("Not found", {status:404}); }
}
