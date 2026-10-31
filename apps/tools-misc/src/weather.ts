import {z} from "zod";
import {forecastInput, locationInput} from "./contracts";

class WeatherError extends Error {}
const number = z.number().finite().nullable();
const values = z.array(number).min(1).max(7);
const locations = z.object({results: z.array(z.object({
  id: z.number().int(), name: z.string().max(200), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  country: z.string().max(200).optional(), country_code: z.string().max(2).optional(), admin1: z.string().max(200).optional(),
  timezone: z.string().max(100).optional(),
})).max(5).default([])});
const forecast = z.object({
  latitude: z.number().finite(), longitude: z.number().finite(), timezone: z.string().max(100), utc_offset_seconds: z.number().finite(),
  current: z.object({time: z.string().max(40), temperature_2m: number, apparent_temperature: number, weather_code: number, wind_speed_10m: number}),
  daily: z.object({time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(7), weather_code: values,
    temperature_2m_max: values, temperature_2m_min: values, precipitation_probability_max: values, precipitation_sum: values, wind_speed_10m_max: values}),
});
export function weatherDescription(code: number | null): string | null {
  if (code === null) return null;
  const labels: Record<number,string> = {0:"快晴",1:"晴れ",2:"晴れ時々曇り",3:"曇り",45:"霧",48:"着氷性の霧",
    51:"弱い霧雨",53:"霧雨",55:"強い霧雨",56:"弱い着氷性の霧雨",57:"強い着氷性の霧雨",
    61:"弱い雨",63:"雨",65:"強い雨",66:"弱い着氷性の雨",67:"強い着氷性の雨",71:"弱い雪",73:"雪",75:"強い雪",77:"霧雪",
    80:"弱いにわか雨",81:"にわか雨",82:"激しいにわか雨",85:"弱いにわか雪",86:"強いにわか雪",95:"雷雨",96:"雹を伴う雷雨",99:"激しい雹を伴う雷雨"};
  return labels[code] ?? "不明";
}
export class WeatherService {
  constructor(private request: typeof fetch = fetch.bind(globalThis)) {}
  private async read(url: URL): Promise<unknown> {
    const response = await this.request(url.href, {redirect:"manual", signal:AbortSignal.timeout(8000), headers:{Accept:"application/json"}});
    if (!response.ok) {
      await response.body?.cancel();
      throw new WeatherError(response.status === 429 ? "weather_rate_limited" : "weather_upstream_error");
    }
    if (!response.body) throw new WeatherError("weather_invalid_response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) { await reader.cancel(); throw new WeatherError("weather_response_too_large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  private async run<T>(operation: string, action: () => Promise<T>) {
    const start = Date.now();
    try {
      const result = await action();
      console.log(JSON.stringify({event:"misc.weather",operation,ok:true,durationMs:Date.now()-start}));
      return {ok:true as const, fetchedAt:new Date().toISOString(), attribution:{name:"Open-Meteo",url:"https://open-meteo.com/",licence:"CC BY 4.0"}, ...result};
    } catch (error) {
      const code = error instanceof WeatherError ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? "weather_invalid_response"
        : error instanceof Error && ["AbortError","TimeoutError"].includes(error.name) ? "weather_timeout" : "weather_unavailable";
      console.warn(JSON.stringify({event:"misc.weather",operation,ok:false,error:code,durationMs:Date.now()-start}));
      return {ok:false as const,error:code};
    }
  }
  async search(request: unknown) {
    const input = locationInput.safeParse(request);
    if (!input.success) return {ok:false as const,error:"invalid_tool_arguments"};
    return this.run("locations", async () => {
      const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
      url.search = new URLSearchParams({name:input.data.query,count:"5",language:"ja",format:"json",...(input.data.countryCode ? {countryCode:input.data.countryCode} : {})}).toString();
      return {locations:locations.parse(await this.read(url)).results,locationAttribution:{name:"GeoNames",url:"https://www.geonames.org/"}};
    });
  }
  async getForecast(request: unknown) {
    const input = forecastInput.safeParse(request);
    if (!input.success) return {ok:false as const,error:"invalid_tool_arguments"};
    return this.run("forecast", async () => {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({latitude:String(input.data.latitude),longitude:String(input.data.longitude),forecast_days:String(input.data.days),
        timezone:"auto",temperature_unit:"celsius",wind_speed_unit:"ms",precipitation_unit:"mm",
        current:"temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        daily:"weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max"}).toString();
      const data = forecast.parse(await this.read(url));
      if (data.daily.time.length !== input.data.days || Object.values(data.daily).some(values => values.length !== data.daily.time.length)) throw new WeatherError("weather_invalid_response");
      return {location:{latitude:data.latitude,longitude:data.longitude},timezone:data.timezone,utcOffsetSeconds:data.utc_offset_seconds,
        units:{temperature:"°C",windSpeed:"m/s",precipitation:"mm",precipitationProbability:"%"},
        current:{...data.current,description:weatherDescription(data.current.weather_code)},
        daily:data.daily.time.map((date,i)=>({date,weatherCode:data.daily.weather_code[i],description:weatherDescription(data.daily.weather_code[i]),
          temperatureMax:data.daily.temperature_2m_max[i],temperatureMin:data.daily.temperature_2m_min[i],
          precipitationProbabilityMax:data.daily.precipitation_probability_max[i],precipitationSum:data.daily.precipitation_sum[i],windSpeedMax:data.daily.wind_speed_10m_max[i]}))};
    });
  }
}
