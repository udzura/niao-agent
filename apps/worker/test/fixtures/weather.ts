export function forecastFixture(days = 3) {
  const repeat = (value: number | null) => Array.from({length:days},()=>value);
  return {latitude:35.7,longitude:139.7,timezone:"Asia/Tokyo",utc_offset_seconds:32400,
    current:{time:"2026-10-30T12:00",temperature_2m:20,apparent_temperature:19,weather_code:1,wind_speed_10m:2},
    daily:{time:Array.from({length:days},(_,i)=>new Date(Date.UTC(2026,9,30+i)).toISOString().slice(0,10)),weather_code:repeat(3),temperature_2m_max:repeat(23),
      temperature_2m_min:repeat(15),precipitation_probability_max:repeat(30),precipitation_sum:repeat(1),wind_speed_10m_max:repeat(4)}};
}
export const locationFixture = {results:[{id:1850147,name:"東京",latitude:35.7,longitude:139.7,country:"日本",country_code:"JP",admin1:"東京都",timezone:"Asia/Tokyo"}]};
