import {env} from "cloudflare:test";
import {describe,expect,it,vi} from "vitest";
import {WeatherService} from "../../tools-misc/src/weather";
import {miscTools} from "../src/misc-tools";
import {WorkersAIModel} from "../src/model";
import {forecastFixture,locationFixture} from "./fixtures/weather";
const signal = () => new AbortController().signal;

describe("Open-Meteo weather service",()=>{
  it("encodes Japanese places, filters countries, returns multiple candidates without auto-selection",async()=>{
    const request = vi.fn(async (url: string, options: RequestInit) => {
      const target = new URL(url);
      expect(target.origin).toBe("https://geocoding-api.open-meteo.com");
      expect(target.searchParams.get("name")).toBe("東京");
      expect(target.searchParams.get("countryCode")).toBe("JP");
      expect(options.redirect).toBe("manual");
      return Response.json(locationFixture);
    });
    const result = await new WeatherService(request as typeof fetch).search({query:" 東京 ",countryCode:"jp"});
    expect(result).toMatchObject({ok:true,locations:[{name:"東京",latitude:35.7}],attribution:{name:"Open-Meteo"},locationAttribution:{name:"GeoNames"}});
    const missing = await new WeatherService(async()=>Response.json({results:[]})).search({query:"Unknown"});
    expect(missing).toMatchObject({ok:true,locations:[]});
  });
  it("validates coordinates and bounds forecast days without network access on bad input",async()=>{
    const request = vi.fn(); const service = new WeatherService(request);
    for (const args of [null,{}, {latitude:91,longitude:0},{latitude:0,longitude:181},{latitude:NaN,longitude:1},
      {latitude:1,longitude:1,days:8},{latitude:1,longitude:1,days:1.5},{latitude:1,longitude:1,url:"https://evil.invalid"}]) {
      expect(await service.getForecast(args)).toEqual({ok:false,error:"invalid_tool_arguments"});
    }
    for (const args of [{query:""},{query:"x"},{query:"x".repeat(121)},{query:"Tokyo",countryCode:"Japan"}]) {
      expect(await service.search(args)).toEqual({ok:false,error:"invalid_tool_arguments"});
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("returns local dates, explicit units and conditions and preserves null data",async()=>{
    const data = forecastFixture(); data.daily.temperature_2m_min[0] = null;
    const service = new WeatherService(async (url) => {
      const query = new URL(String(url)).searchParams;
      expect(query.get("forecast_days")).toBe("3"); expect(query.get("timezone")).toBe("auto");
      expect(query.get("wind_speed_unit")).toBe("ms");
      return Response.json(data);
    });
    expect(await service.getForecast({latitude:35.7,longitude:139.7})).toMatchObject({ok:true,timezone:"Asia/Tokyo",
      units:{temperature:"°C",windSpeed:"m/s"},current:{description:"晴れ"},daily:[
        {date:"2026-10-30",temperatureMin:null,description:"曇り"},{date:"2026-10-31"},{date:"2026-11-01"}]});
  });
  it("rejects malformed/oversized/inconsistent responses and maps network, timeout, HTTP and rate-limit failures",async()=>{
    const broken = forecastFixture(); broken.daily.weather_code.pop();
    const cases: [() => Promise<Response>,string][] = [
      [async()=>Response.json({}),"weather_invalid_response"], [async()=>new Response("broken"),"weather_invalid_response"],
      [async()=>Response.json(broken),"weather_invalid_response"], [async()=>new Response("x".repeat(65537)),"weather_response_too_large"],
      [async()=>new Response(null,{status:429}),"weather_rate_limited"], [async()=>new Response(null,{status:503}),"weather_upstream_error"],
      [async()=>new Response(null,{status:302,headers:{Location:"https://evil.invalid"}}),"weather_upstream_error"],
      [async()=>{throw new TypeError("private location")},"weather_unavailable"],
      [async()=>{throw new DOMException("expired","TimeoutError")},"weather_timeout"],
    ];
    for (const [request,error] of cases) expect(await new WeatherService(request).getForecast({latitude:0,longitude:0})).toEqual({ok:false,error});
  });
});

describe("weather tool through real Service Binding",()=>{
  const tools = () => miscTools((env as any).TOOLS_MISC).filter(tool=>tool.definition.function.name.includes("weather"));
  it("runs production RPC methods and has no public HTTP API",async()=>{
    const list = tools(); expect(list.map(t=>t.definition.function.name)).toEqual(["search_weather_locations","get_weather_forecast"]);
    expect(await list[0].execute({query:"東京"},signal())).toMatchObject({untrusted_reference_data:true,result:{ok:true,locations:[{country_code:"JP"}]}});
    expect(await list[1].execute({latitude:35.7,longitude:139.7,days:2},signal())).toMatchObject({result:{ok:true,daily:[{date:"2026-10-30"},{date:"2026-10-31"}]}});
    expect(await list[1].execute({latitude:99,longitude:0},signal())).toEqual({ok:false,error:"invalid_tool_arguments"});
    expect(await (env as any).TOOLS_MISC.getWeatherForecast({latitude:99,longitude:0})).toEqual({ok:false,error:"invalid_tool_arguments"});
    expect((await (env as any).TOOLS_MISC.fetch("https://misc.invalid")).status).toBe(404);
  });
  it("fails safely for missing bindings, RPC failure and cancellation",async()=>{
    expect(miscTools()).toEqual([]);
    const broken = miscTools({getWeatherForecast:async()=>{throw new Error("private binding error")}} as any).find(tool=>tool.definition.function.name === "get_weather_forecast")!;
    expect(await broken.execute({latitude:0,longitude:0},signal())).toEqual({ok:false,error:"weather_unavailable"});
    const controller = new AbortController(); controller.abort();
    await expect(tools()[0].execute({query:"Tokyo"},controller.signal)).rejects.toThrow();
  });
  it("completes the LLM loop: location search -> forecast RPC -> response, preserving tool names",async()=>{
    let round = 0;
    const ai = {run:async (_model: string,input:any)=>{
      expect(input.tools.map((t:any)=>t.function.name)).toContain("get_weather_forecast");
      const index = round++;
      if (index>0) expect(JSON.parse(input.messages.at(-1).content).result.ok).toBe(true);
      const delta = index === 0 ? {tool_calls:[{index:0,id:"loc",function:{name:"search_weather_locations",arguments:JSON.stringify({query:"東京"})}}]}
        : index === 1 ? {tool_calls:[{index:0,id:"forecast",function:{name:"get_weather_forecast",arguments:JSON.stringify({latitude:35.7,longitude:139.7,days:2})}}]}
        : {content:"東京は曇りの予報です。出典: [Open-Meteo](https://open-meteo.com/)"};
      return new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: [DONE]\n\n`));c.close();}});
    }} as unknown as Ai;
    const events=[];
    for await (const event of new WorkersAIModel(ai,"@cf/zai-org/glm-4.7-flash",undefined,false,tools()).stream([],signal())) events.push(event);
    expect(round).toBe(3);
    expect(events).toContainEqual({toolStatus:"running",name:"get_weather_forecast"});
    expect(events).toContainEqual({toolStatus:"completed",name:"search_weather_locations"});
    expect(events).toContainEqual({text:"東京は曇りの予報です。出典: [Open-Meteo](https://open-meteo.com/)"});
  });
});
